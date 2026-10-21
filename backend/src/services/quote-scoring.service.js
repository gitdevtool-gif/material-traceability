/**
 * Quote Scoring Service
 * Advisory, weighted multi-criteria scoring for RFQ quotation comparison.
 *
 * IMPORTANT: This is a *suggestion* to speed up Director review — it never
 * decides anything on its own. The actual award still requires a human
 * POST /api/procurement/evaluation call. Nothing here writes to the DB.
 *
 * ── The math ─────────────────────────────────────────────────────────────
 * Each quotation gets a 0–100 score built from five weighted sub-scores,
 * each normalized to a 0–1 range before weighting:
 *
 *   1. Price competitiveness (default 45%)
 *      Spend-weighted ratio of "cheapest quoted price for this item" to
 *      "this supplier's price for this item", averaged across the items
 *      the supplier actually quoted. Weighting each item by
 *      (RequiredQty × cheapestUnitPrice) means high-value items influence
 *      the score more than low-value ones — a shortcut, not a full LP
 *      optimization, but good enough to flag the cheapest overall option
 *      without letting a 5-item packaging line dominate a bulk raw
 *      material line.
 *
 *   2. ERP benchmark (default 15%)
 *      This supplier's price vs. the 12-month Busy PurOrder average for
 *      that item. Ratio is (benchmarkAvg / supplierPrice), capped at 1.3
 *      so an unrealistically low quote doesn't distort the score.
 *
 *   3. Delivery lead time (default 15%)
 *      Min-max normalized across the suppliers who responded to this RFQ
 *      — fastest gets 1, slowest gets 0. Missing values are neutral (0.5).
 *
 *   4. Payment terms (default 10%)
 *      Best-effort regex extraction of a credit period ("30 days", "45-day
 *      EOM", etc). Longer credit to NCF scores higher, capped at 60 days.
 *      Free text that can't be parsed (e.g. "Cash on delivery") scores 0
 *      explicitly, since COD genuinely offers no credit — this is the one
 *      dimension where "can't parse" and "worst case" happen to coincide.
 *
 *   5. Coverage / completeness (default 15%)
 *      Fraction of the requisition's line items this supplier actually
 *      quoted. A supplier who quoted 3 of 10 items is penalized even if
 *      their 3 prices were excellent, since Procurement would still need
 *      to source the rest elsewhere.
 *
 * All five default weights sum to 1.0 and can be overridden by the caller
 * (e.g. from query params) — they're renormalized if they don't sum to 1.
 */

const DEFAULT_WEIGHTS = {
  price:        0.45,
  benchmark:    0.15,
  delivery:     0.15,
  payment:      0.10,
  completeness: 0.15,
};

function normalizeWeights(weights) {
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  const sum = Object.values(merged).reduce((a, b) => a + (Number(b) || 0), 0);
  if (sum <= 0) return DEFAULT_WEIGHTS;
  const out = {};
  for (const k of Object.keys(merged)) out[k] = (Number(merged[k]) || 0) / sum;
  return out;
}

// Extracts a credit-period day count from free-text payment terms.
// Returns null if nothing resembling a day count is found.
function extractCreditDays(paymentTerms) {
  if (!paymentTerms) return null;
  const match = String(paymentTerms).match(/(\d{1,3})\s*[-]?\s*day/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * @param {Array} quotations - each item shaped like the `quotations` array
 *   already built in evaluation.routes.js (QuotationId, DeliveryDays,
 *   PaymentTerms, lineItems: [{ RequisitionItemId, UnitPrice, Qty, benchmark }]).
 * @param {number} requiredItemCount - total distinct RequisitionItems on
 *   this RFQ, for the completeness score denominator.
 * @param {object} weightOverrides - optional partial weight overrides.
 * @returns {{ weights, scored: Array, suggestedWinnerQuotationId: number|null }}
 */
function scoreQuotations(quotations, requiredItemCount, weightOverrides = {}) {
  const weights = normalizeWeights(weightOverrides);

  if (!quotations || quotations.length === 0) {
    return { weights, scored: [], suggestedWinnerQuotationId: null };
  }

  // ── Step 1: cheapest quoted unit price per item, across all suppliers ──
  const cheapestByItem = {};
  for (const q of quotations) {
    for (const li of q.lineItems) {
      const price = Number(li.UnitPrice);
      if (!(price > 0)) continue;
      if (cheapestByItem[li.RequisitionItemId] === undefined || price < cheapestByItem[li.RequisitionItemId]) {
        cheapestByItem[li.RequisitionItemId] = price;
      }
    }
  }

  // ── Step 2: delivery day min/max across responding suppliers ──
  const deliveryDaysList = quotations
    .map((q) => q.DeliveryDays)
    .filter((d) => d !== null && d !== undefined);
  const minDelivery = deliveryDaysList.length ? Math.min(...deliveryDaysList) : null;
  const maxDelivery = deliveryDaysList.length ? Math.max(...deliveryDaysList) : null;

  const scored = quotations.map((q) => {
    // ── Price competitiveness ──
    let priceWeightedSum = 0;
    let priceWeightTotal = 0;
    for (const li of q.lineItems) {
      const supplierPrice = Number(li.UnitPrice);
      const cheapest = cheapestByItem[li.RequisitionItemId];
      if (!(supplierPrice > 0) || !cheapest) continue;
      const itemWeight = Number(li.RequiredQty || li.Qty || 1) * cheapest; // spend weight
      const ratio = cheapest / supplierPrice; // <=1, 1 == cheapest
      priceWeightedSum += ratio * itemWeight;
      priceWeightTotal += itemWeight;
    }
    const priceScore = priceWeightTotal > 0 ? priceWeightedSum / priceWeightTotal : 0;

    // ── ERP benchmark ──
    let benchWeightedSum = 0;
    let benchWeightTotal = 0;
    for (const li of q.lineItems) {
      const supplierPrice = Number(li.UnitPrice);
      const bench = li.benchmark;
      if (!(supplierPrice > 0) || !bench || !bench.AvgUnitPrice) continue;
      const itemWeight = Number(li.RequiredQty || li.Qty || 1) * supplierPrice;
      const ratio = Math.min(1.3, Number(bench.AvgUnitPrice) / supplierPrice) / 1.3; // normalize to 0-1ish
      benchWeightedSum += ratio * itemWeight;
      benchWeightTotal += itemWeight;
    }
    const benchmarkScore = benchWeightTotal > 0 ? benchWeightedSum / benchWeightTotal : 0.5; // neutral if no benchmark data

    // ── Delivery lead time ──
    let deliveryScore = 0.5; // neutral default
    if (q.DeliveryDays !== null && q.DeliveryDays !== undefined && minDelivery !== null) {
      deliveryScore = maxDelivery > minDelivery
        ? (maxDelivery - q.DeliveryDays) / (maxDelivery - minDelivery)
        : 1; // everyone quoted the same lead time
    }

    // ── Payment terms ──
    const creditDays = extractCreditDays(q.PaymentTerms);
    const paymentScore = creditDays !== null ? Math.min(creditDays, 60) / 60 : 0;

    // ── Coverage / completeness ──
    const itemsQuoted = q.lineItems.length;
    const completenessScore = requiredItemCount > 0
      ? Math.min(1, itemsQuoted / requiredItemCount)
      : 1;

    const totalScore =
      weights.price        * priceScore +
      weights.benchmark    * benchmarkScore +
      weights.delivery     * deliveryScore +
      weights.payment      * paymentScore +
      weights.completeness * completenessScore;

    return {
      quotationId: q.QuotationId,
      supplierName: q.SupplierName,
      scores: {
        price:        Math.round(priceScore * 100),
        benchmark:    Math.round(benchmarkScore * 100),
        delivery:     Math.round(deliveryScore * 100),
        payment:      Math.round(paymentScore * 100),
        completeness: Math.round(completenessScore * 100),
      },
      totalScore: Math.round(totalScore * 1000) / 10, // one decimal, 0-100
      itemsQuoted,
      requiredItemCount,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  const top = scored[0] || null;
  const runnerUp = scored[1] || null;
  const closeCall = top && runnerUp ? (top.totalScore - runnerUp.totalScore) <= 2 : false;

  return {
    weights,
    scored,
    suggestedWinnerQuotationId: top ? top.quotationId : null,
    closeCall,
  };
}

module.exports = { scoreQuotations, DEFAULT_WEIGHTS };