/**
 * Requisition audit report (2026-10-22) — every requisition line from every
 * factory, with the stock position AT THE TIME it was requested, its whole
 * approval / sourcing / PO / receipt chain, and automatic red flags for an
 * auditor. Read-only; nothing is stored.
 *
 * Stock at request = Busy stock at the START of the requisition date
 * (Tran4 opening + Tran2 stock movements dated before that day) — what the
 * factory and Central Stores actually held when the request was made.
 *   company    all real stores (excl. "Materials Consumable", as the stock engine)
 *   central    the Central Stores store
 *   own store  the store the requisition was raised for (Requisitions.MatCenter)
 * Reorder picture AT THE REQUEST DATE — the Reorder Levels page's own formula
 * (stock.service computeLevels: reorder = max monthly use × lead, min, max with
 * EOQ) fed with company consumption (production use + issues + net transfers
 * out) for the 6 complete months BEFORE the request month. Position then:
 * below reorder level (an order was due) / above reorder level / above maximum.
 * Today's levels (ReorderStatus) and Busy's own critical levels are shown too.
 *
 * Requisitions from Busy store quantities negative — quantities are taken as
 * absolute. Stock checks are skipped when the requisition's unit differs from
 * Busy's unit for the item (Kgs vs ton, Pcs vs bags): the numbers don't compare.
 *
 * Red flags (severity high / medium / low):
 *   STOCK_AVAILABLE      ordered while company stock was ABOVE the reorder level and the
 *                        requester's store + Central Stores already held the quantity
 *   OVER_ORDER           stock + quantity asked > 110% of the maximum level AND > 2 months of use
 *   NO_USAGE             no use at all in the 6 months before the request
 *   UNIT_MISMATCH        requisition unit ≠ Busy unit — stock checks skipped (note)
 *   DUPLICATE            same item listed twice on one requisition, or another requisition
 *                        for the same store within 14 days and together they exceed the max level
 *   SELF_APPROVED        the person who raised it also approved it
 *   SAME_APPROVER        the same person approved at Central Stores and at Ops
 *   AWARD_ABOVE_APPROVED awarded more than was approved
 *   NOT_LOWEST           awarded above the lowest valid quote (ex VAT)
 *   SINGLE_QUOTE         awarded with only one supplier quoting
 *   PO_VS_AWARD          Busy PO value differs from the award (ex VAT, > 1%)
 *   PRICE_ABOVE_AVG      PO price > 25% above the 12-month average purchase price
 *   OVER_RECEIVED        received more than the PO ordered
 *   PO_NOT_FOUND         linked Busy PO no longer exists in Busy
 *   SLOW                 approved but no PO after 30 days, or PO > 30 days after the request
 */
const { sql: erpSql } = require('../erpDb');
const { loadBusyPos } = require('./trace.service');
const { resolveItems, getAvgInwardPrice, getEoq, computeLevels, isNonStock, EXCLUDED_STORES } = require('./stock.service');

const VAT = 1 + (Number(process.env.VAT_RATE) || 0.16);
const PREV_FY_DB = process.env.BUSY_PREV_FY_DB || 'BusyComp0006_db12025';
const CENTRAL = String(process.env.BUSY_CENTRAL_STORES_NAME || 'CENTRAL STORES').toUpperCase();
const DAY = 864e5;
const norm = (s) => String(s || '').trim().toUpperCase();
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const days = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / DAY) : null);
const intList = (arr) => [...new Set(arr.map((x) => parseInt(x, 10)).filter(Number.isFinite))];

const FLAG_INFO = {
  STOCK_AVAILABLE:      { severity: 'high',   label: 'Stock above reorder level' },
  OVER_ORDER:           { severity: 'medium', label: 'Above maximum level' },
  NO_USAGE:             { severity: 'low',    label: 'No use in 6 months' },
  UNIT_MISMATCH:        { severity: 'low',    label: 'Unit differs from Busy' },
  DUPLICATE:            { severity: 'medium', label: 'Possible duplicate' },
  SELF_APPROVED:        { severity: 'high',   label: 'Approved own request' },
  SAME_APPROVER:        { severity: 'medium', label: 'One person approved twice' },
  AWARD_ABOVE_APPROVED: { severity: 'medium', label: 'Awarded above approved qty' },
  NOT_LOWEST:           { severity: 'high',   label: 'Not the lowest quote' },
  SINGLE_QUOTE:         { severity: 'medium', label: 'Single quote' },
  PO_VS_AWARD:          { severity: 'high',   label: 'PO differs from award' },
  PRICE_ABOVE_AVG:      { severity: 'medium', label: 'Price above 12-month average' },
  OVER_RECEIVED:        { severity: 'high',   label: 'Received more than ordered' },
  PO_NOT_FOUND:         { severity: 'high',   label: 'PO missing in Busy' },
  SLOW:                 { severity: 'low',    label: 'Slow (> 30 days)' },
};

// ── Our side: requisition lines with approvals and sourcing ─────────────────

async function loadLines(pool, { from, to, factory }) {
  const req = pool.request().input('from', from).input('to', to);
  let where = '';
  if (factory) { req.input('factory', factory); where = ' AND UPPER(LTRIM(RTRIM(r.MatCenter))) = UPPER(LTRIM(RTRIM(@factory)))'; }
  return (await req.query(`
    SELECT r.RequisitionId, r.BusyOrdNo, COALESCE(r.BusyDate, CAST(r.CreatedAt AS date)) AS ReqDate,
           LTRIM(RTRIM(r.MatCenter)) AS MatCenter, r.Status, r.Source, r.OrderType, r.CreatedAt,
           r.CreatedByUserId, cu.FullName AS CreatedBy,
           r.CentralStoresApprovedByUserId, cs.FullName AS CentralStoresBy, r.CentralStoresApprovedAt, r.CentralStoresRejectionReason,
           r.OpsApprovedByUserId, op.FullName AS OpsBy, r.OpsApprovedAt, r.OpsRejectionReason,
           ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty, ri.Unit, ri.Category, ri.BusyPrice, ri.RFQId,
           ia.Decision AS OpsDecision, ia.ApprovedQty AS OpsApprovedQty, ia.DecidedAt AS OpsDecidedAt,
           ia.DecidedByUserId AS OpsDecidedById, iu.FullName AS OpsDecidedBy, ia.RejectionReason AS OpsItemRejection,
           csd.Decision AS CsDecision, csd.ApprovedQty AS CsApprovedQty, csd.DecidedAt AS CsDecidedAt,
           csd.DecidedByUserId AS CsDecidedById, csu.FullName AS CsDecidedBy, csd.RejectionReason AS CsItemRejection,
           h.Reason AS HoldReason, h.HeldAt
    FROM dbo.Requisitions r
    JOIN dbo.RequisitionItems ri ON ri.RequisitionId = r.RequisitionId
    LEFT JOIN dbo.Users cu ON cu.UserId = r.CreatedByUserId
    LEFT JOIN dbo.Users cs ON cs.UserId = r.CentralStoresApprovedByUserId
    LEFT JOIN dbo.Users op ON op.UserId = r.OpsApprovedByUserId
    OUTER APPLY (SELECT TOP 1 x.* FROM dbo.RequisitionItemApprovals x
                 WHERE x.RequisitionItemId = ri.RequisitionItemId ORDER BY x.DecidedAt DESC) ia
    LEFT JOIN dbo.Users iu ON iu.UserId = ia.DecidedByUserId
    OUTER APPLY (SELECT TOP 1 d.* FROM dbo.CentralStoresItemDecisions d
                 WHERE d.RequisitionId = r.RequisitionId AND UPPER(LTRIM(RTRIM(d.ItemName))) = UPPER(LTRIM(RTRIM(ri.ItemName)))
                 ORDER BY d.DecidedAt DESC) csd
    LEFT JOIN dbo.Users csu ON csu.UserId = csd.DecidedByUserId
    OUTER APPLY (SELECT TOP 1 hh.Reason, hh.HeldAt FROM dbo.RFQItemHolds hh
                 WHERE hh.RequisitionItemId = ri.RequisitionItemId ORDER BY hh.HeldAt DESC) h
    WHERE COALESCE(r.BusyDate, CAST(r.CreatedAt AS date)) BETWEEN @from AND @to ${where}
    ORDER BY ReqDate DESC, r.RequisitionId DESC, ri.RequisitionItemId`)).recordset;
}

async function loadSourcing(pool, itemIds, rfqIds) {
  const out = { rfqs: new Map(), quotes: new Map(), lowest: new Map(), awards: new Map(), lpos: [] };
  if (!itemIds.length) return out;
  const inI = intList(itemIds).join(',');
  const inR = intList(rfqIds).join(',');

  if (inR) {
    for (const r of (await pool.request().query(`
      SELECT rfq.RFQId, rfq.RFQNumber, rfq.IssuedAt, iu.FullName AS IssuedBy,
             (SELECT COUNT(*) FROM dbo.RFQDispatches d WHERE d.RFQId = rfq.RFQId) AS Dispatches,
             (SELECT MIN(d.SentAt) FROM dbo.RFQDispatches d WHERE d.RFQId = rfq.RFQId) AS FirstSentAt,
             ev.ApprovedAt AS AwardedAt, du.FullName AS Director
      FROM dbo.RFQs rfq
      LEFT JOIN dbo.Users iu ON iu.UserId = rfq.IssuedByUserId
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.RFQId = rfq.RFQId
      LEFT JOIN dbo.Users du ON du.UserId = ev.DirectorUserId
      WHERE rfq.RFQId IN (${inR})`)).recordset) out.rfqs.set(r.RFQId, r);

    out.lpos = (await pool.request().query(`
      SELECT rec.RFQId, rec.SupplierId, LTRIM(RTRIM(rec.BusyPurOrdNo)) AS BusyPurOrdNo, rec.TotalQuotedAmt, rec.TotalActualAmt, rec.VarianceAmt
      FROM dbo.LPOReconciliation rec WHERE rec.RFQId IN (${inR})`)).recordset;
  }

  // Quotes per line: how many suppliers quoted, and the lowest valid price ex VAT (and who).
  for (const q of (await pool.request().query(`
    WITH v AS (
      SELECT li.RequisitionItemId, q.SupplierId, s.SupplierName,
             CASE WHEN ISNULL(li.IsNotAvailable, 0) = 0 AND li.UnitPrice > 0
                  THEN li.UnitPrice / CASE WHEN li.IsVatInclusive = 1 THEN ${VAT} ELSE 1 END END AS PriceExVat
      FROM dbo.QuotationLineItems li
      JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId AND ISNULL(q.IsWithdrawn, 0) = 0
      LEFT JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
      WHERE li.RequisitionItemId IN (${inI}))
    SELECT RequisitionItemId, COUNT(DISTINCT SupplierId) AS Suppliers,
           COUNT(DISTINCT CASE WHEN PriceExVat IS NOT NULL THEN SupplierId END) AS PricedSuppliers,
           (SELECT TOP 1 v2.SupplierName FROM v v2 WHERE v2.RequisitionItemId = v.RequisitionItemId AND v2.PriceExVat IS NOT NULL ORDER BY v2.PriceExVat) AS LowestSupplier,
           MIN(PriceExVat) AS LowestExVat
    FROM v GROUP BY RequisitionItemId`)).recordset) out.quotes.set(q.RequisitionItemId, q);

  // Award per line — split awards (QuoteEvaluationItems) or the single winning quotation.
  for (const a of (await pool.request().query(`
    SELECT qei.RequisitionItemId, qei.SupplierId, s.SupplierName, qei.UnitPrice, qei.Qty, li.IsVatInclusive
    FROM dbo.QuoteEvaluationItems qei
    JOIN dbo.Suppliers s ON s.SupplierId = qei.SupplierId
    LEFT JOIN dbo.QuotationLineItems li ON li.QuotationLineItemId = qei.QuotationLineItemId
    WHERE qei.RequisitionItemId IN (${inI})
    UNION ALL
    SELECT li.RequisitionItemId, q.SupplierId, s.SupplierName, li.UnitPrice, li.Qty, li.IsVatInclusive
    FROM dbo.QuoteEvaluations ev
    JOIN dbo.Quotations q ON q.QuotationId = ev.WinningQuotationId
    JOIN dbo.QuotationLineItems li ON li.QuotationId = q.QuotationId
    JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
    WHERE li.RequisitionItemId IN (${inI})
      AND NOT EXISTS (SELECT 1 FROM dbo.QuoteEvaluationItems x WHERE x.QuoteEvaluationId = ev.QuoteEvaluationId)`)).recordset) {
    out.awards.set(a.RequisitionItemId, a);
  }
  return out;
}

// ── Busy side: stock as at a date, use before it ─────────────────────────────

/**
 * Stock movements per item × store × day, plus opening. Returns
 * Map(itemCode -> { opening: Map(store -> qty), moves: [{ store, day, qty }] sorted by day }).
 */
async function loadStockSeries(erpPool, itemCodes) {
  const out = new Map();
  const ids = intList(itemCodes);
  if (!ids.length) return { series: out, storeNames: new Map() };
  const inC = ids.join(',');
  const rows = (await erpPool.request().query(`
    SELECT t.MasterCode1 AS ItemCode, t.MasterCode2 AS StoreCode, NULL AS Dy, SUM(t.D1) AS Qty
    FROM dbo.Tran4 t WHERE t.MasterCode2 <> 0 AND t.MasterCode1 IN (${inC})
    GROUP BY t.MasterCode1, t.MasterCode2
    UNION ALL
    SELECT t.MasterCode1, t.MasterCode2, CAST(t.[Date] AS date), SUM(t.Value1)
    FROM dbo.Tran2 t WHERE t.RecType = 2 AND t.MasterCode1 IN (${inC})
    GROUP BY t.MasterCode1, t.MasterCode2, CAST(t.[Date] AS date)`)).recordset;
  const storeCodes = intList(rows.map((r) => r.StoreCode));
  const storeNames = new Map(storeCodes.length ? (await erpPool.request().query(
    `SELECT Code, UPPER(LTRIM(RTRIM(Name))) AS Name FROM dbo.Master1 WHERE Code IN (${storeCodes.join(',')})`)).recordset.map((s) => [s.Code, s.Name]) : []);
  for (const r of rows) {
    let it = out.get(r.ItemCode);
    if (!it) out.set(r.ItemCode, (it = { opening: [], moves: [] }));
    const row = { store: r.StoreCode, qty: Number(r.Qty) || 0, day: r.Dy ? ymd(r.Dy) : null };
    (row.day ? it.moves : it.opening).push(row);
  }
  for (const it of out.values()) it.moves.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { series: out, storeNames };
}

/** Stock of one item at the start of `day` (null = now): company, Central Stores, a named store. */
function stockAt(series, storeNames, itemCode, day, ownStore) {
  const it = series.get(itemCode);
  const res = { company: 0, central: 0, own: 0 };
  if (!it) return res;
  const own = norm(ownStore);
  const add = (r) => {
    const name = storeNames.get(r.store) || '';
    if (!EXCLUDED_STORES.includes(r.store)) res.company += r.qty;
    if (name === CENTRAL) res.central += r.qty;
    if (own && name === own) res.own += r.qty;
  };
  it.opening.forEach(add);
  for (const m of it.moves) { if (day && m.day >= day) break; add(m); }
  return { company: r2(res.company), central: r2(res.central), own: r2(res.own) };
}

/**
 * Company consumption per item per day from `from` (current year's DB by
 * code, previous year's DB by item name). Map(itemCode -> [{ day, qty }]).
 */
async function loadDailyUse(erpPool, items, from) {
  const out = new Map();
  if (!items.length) return out;
  const excluded = EXCLUDED_STORES.length ? EXCLUDED_STORES.join(',') : '-1';
  const useSql = (p, keySel, keyWhere) => `
    SELECT ${keySel} AS ItemKey, CAST(t.[Date] AS date) AS Dy,
           SUM(CASE WHEN t.VchType = 6 AND t.Value1 < 0 THEN -t.Value1
                    WHEN t.VchType = 11 AND t.Value1 < 0 AND pr.Code IS NULL THEN -t.Value1
                    WHEN t.VchType = 5 THEN -t.Value1 ELSE 0 END) AS Qty
    FROM ${p}dbo.Tran2 t
    LEFT JOIN (SELECT Code FROM ${p}dbo.Master1 WHERE MasterType = 21 AND LTRIM(RTRIM(Name)) = '11Pur-return') pr ON pr.Code = t.VchSeriesCode
    ${p ? `JOIN ${p}dbo.Master1 i ON i.Code = t.MasterCode1` : ''}
    WHERE t.RecType = 2 AND t.VchType IN (5, 6, 11) AND t.MasterCode2 NOT IN (${excluded}) AND t.[Date] >= @from ${keyWhere}
    GROUP BY ${keySel}, CAST(t.[Date] AS date)`;
  const push = (code, dy, qty) => {
    if (!code || !qty) return;
    let a = out.get(code);
    if (!a) out.set(code, (a = []));
    a.push({ day: ymd(dy), qty: Number(qty) || 0 });
  };
  const cur = await erpPool.request().input('from', erpSql.DateTime, from)
    .query(useSql('', 't.MasterCode1', ` AND t.MasterCode1 IN (${intList(items.map((i) => i.itemCode)).join(',')})`));
  cur.recordset.forEach((r) => push(r.ItemKey, r.Dy, r.Qty));

  if (/^[A-Za-z0-9_]+$/.test(PREV_FY_DB)) {
    const codeByName = new Map(items.map((i) => [norm(i.itemName), i.itemCode]));
    try {
      const prev = await erpPool.request().input('from', erpSql.DateTime, from)
        .query(useSql(`[${PREV_FY_DB}].`, 'UPPER(LTRIM(RTRIM(i.Name)))', ''));
      prev.recordset.forEach((r) => push(codeByName.get(r.ItemKey), r.Dy, r.Qty));
    } catch { /* previous year's database not reachable — current year only */ }
  }
  return out;
}

// Materiality for the quantity flags (KES): small spares bought a few at a time aren't findings.
const MATERIAL_KES = Number(process.env.AUDIT_MATERIAL_KES) || 20000;
// Stock + order covering up to this many months of use is never "over-ordering".
const OVER_MONTHS = Number(process.env.AUDIT_OVER_MONTHS) || 2;
const estValueOf = (l, qty, avgP) => (qty * (Number(l.BusyPrice) || avgP || 0)) || null;

/**
 * Monthly use for the 6 complete calendar months before `day`'s month, in the
 * shape computeLevels expects: max6, min6 (months with use), avg3 (last 3).
 */
function useBefore(arr, day) {
  const [y, m] = day.split('-').map(Number);
  const keys = [];
  for (let k = 6; k >= 1; k--) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const byMonth = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const u of arr || []) { const k = u.day.slice(0, 7); if (k in byMonth) byMonth[k] += u.qty; }
  const series = keys.map((k) => Math.max(0, byMonth[k]));
  const nonZero = series.filter((q) => q > 0);
  return {
    months: keys.map((k, i) => ({ month: k, qty: r2(series[i]) })),
    max6: r2(Math.max(0, ...series)),
    min6: r2(nonZero.length ? Math.min(...nonZero) : 0),
    avg3: r2(series.slice(-3).reduce((a, b) => a + b, 0) / 3),
  };
}

// Units as typed on requisitions vs Busy's unit names ("Pcs" = "Pcs.", "Litres" = "Lts").
const UNIT_ALIASES = {
  pcs: ['pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'number', 'unit', 'units', 'each', 'ea'],
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  l: ['l', 'lt', 'lts', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
  m: ['m', 'mt', 'mts', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters'],
  ton: ['t', 'ton', 'tons', 'tonne', 'tonnes'],
  pair: ['pair', 'pairs', 'pr'],
};
const UNIT_KEY = new Map(Object.entries(UNIT_ALIASES).flatMap(([k, v]) => v.map((a) => [a, k])));
const unitKey = (u) => { const s = String(u || '').toLowerCase().replace(/[^a-z]/g, ''); return UNIT_KEY.get(s) || s; };

const max0 = (n) => Math.max(0, Number(n) || 0);

// ── The report ───────────────────────────────────────────────────────────────

async function buildRequisitionAudit(pool, erpPool, { from, to, factory }) {
  const lines = await loadLines(pool, { from, to, factory });
  const sourcing = await loadSourcing(pool, lines.map((l) => l.RequisitionItemId), lines.map((l) => l.RFQId).filter(Boolean));

  // Busy items: requisitions carry the Busy item name (ItemCode on manual ones).
  const names = [...new Set(lines.map((l) => (l.ItemCode || l.ItemName || '').trim()).filter(Boolean))];
  const busyItems = [];
  for (let k = 0; k < names.length; k += 900) busyItems.push(...await resolveItems(erpPool, { itemNames: names.slice(k, k + 900) }));
  const itemByName = new Map(busyItems.map((b) => [norm(b.itemName), b]));
  const codes = busyItems.map((b) => b.itemCode);

  // Use is needed for the 6 complete months before the earliest request's month.
  const earliest = new Date(lines.reduce((m, l) => (l.ReqDate < m ? l.ReqDate : m), new Date(to)));
  const useFrom = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth() - 6, 1));
  const [{ series, storeNames }, dailyUse, avgPrice, eoq, reorder, pos] = await Promise.all([
    loadStockSeries(erpPool, codes),
    loadDailyUse(erpPool, busyItems, useFrom),
    codes.length ? getAvgInwardPrice(erpPool, codes) : new Map(),
    codes.length ? getEoq(erpPool, codes) : new Map(),
    pool.request().query(`SELECT UPPER(LTRIM(RTRIM(ItemName))) AS K, ReorderLevel, MinimumStockLevel, MaxStockLevel,
                                 BusyMinLevel, BusyReorderLevel, BusyMaxLevel FROM dbo.ReorderStatus
                         ORDER BY CASE WHEN Store = 'CENTRAL STORES' THEN 1 ELSE 0 END`) // per store since 2026-11-11: Central Stores' row set last, so it wins
      .then((r) => new Map(r.recordset.map((x) => [x.K, x]))),
    loadBusyPos(erpPool, [...new Set(sourcing.lpos.map((l) => l.BusyPurOrdNo).filter(Boolean))]),
  ]);

  const today = ymd(new Date());
  const out = lines.map((l) => {
    const day = ymd(l.ReqDate);
    const busyName = (l.ItemCode || l.ItemName || '').trim();
    const item = itemByName.get(norm(busyName)) || null;
    const stocked = !!item && !isNonStock(item.group);
    const at = item ? stockAt(series, storeNames, item.itemCode, day, l.MatCenter) : null;
    const now = item ? stockAt(series, storeNames, item.itemCode, null, l.MatCenter) : null;
    const lvl = reorder.get(norm(item?.itemName || busyName)) || null;

    // Reorder picture as it stood on the request date.
    const cons = item ? useBefore(dailyUse.get(item.itemCode), day) : null;
    const avgMonthly = cons ? cons.avg3 : null;
    const cover = at && avgMonthly > 0 ? r2(at.company / avgMonthly) : null;
    const lv = item && stocked ? computeLevels({ live: at.company, cons, leadWeeks: item.leadWeeks, eoq: eoq.get(item.itemCode) }) : null;
    const noUse = !!cons && cons.max6 === 0;
    let position = null;
    if (lv) {
      if (noUse) position = { code: 'no_use', label: at.company > 0 ? 'No use in 6 months' : 'No stock, no use' };
      else if (at.company <= 0) position = { code: 'out', label: 'Out of stock' };
      else if (at.company <= lv.minLevel) position = { code: 'critical', label: 'Below minimum' };
      else if (at.company <= lv.reorderLevel) position = { code: 'reorder', label: 'Below reorder level' };
      else if (lv.maxLevel != null && at.company > lv.maxLevel) position = { code: 'above_max', label: 'Above maximum' };
      else position = { code: 'ok', label: 'Above reorder level' };
    }
    const reqUnit = String(l.Unit || '').trim() || null;
    const busyUnit = item?.unitName || null;
    const unitOk = !reqUnit || !busyUnit || unitKey(reqUnit) === unitKey(busyUnit);

    const rfq = l.RFQId ? sourcing.rfqs.get(l.RFQId) : null;
    const q = sourcing.quotes.get(l.RequisitionItemId) || null;
    const award = sourcing.awards.get(l.RequisitionItemId) || null;
    const lpo = award && l.RFQId
      ? sourcing.lpos.find((x) => x.RFQId === l.RFQId && (x.SupplierId === award.SupplierId || x.SupplierId === null)) || null
      : null;
    const po = lpo ? pos[lpo.BusyPurOrdNo] || null : null;
    const poLine = po
      ? po.lines.find((x) => item && x.itemCode === item.itemCode) || po.lines.find((x) => norm(x.itemName) === norm(busyName)) || (po.lines.length === 1 ? po.lines[0] : null)
      : null;
    const firstReceipt = poLine?.receipts?.length ? poLine.receipts.map((r) => r.date).sort()[0] : null;

    // Busy-synced requisitions carry negative quantities.
    const qty = Math.abs(Number(l.Qty) || 0);
    const csRejected = l.CsDecision === 'Rejected' || l.Status === 'RejectedByCentralStores';
    const opsRejected = l.OpsDecision === 'Rejected' || l.Status === 'RejectedByOps';
    const rejected = csRejected || opsRejected;
    const approvedQty = l.OpsApprovedQty != null ? Math.abs(Number(l.OpsApprovedQty)) : l.CsApprovedQty != null ? Math.abs(Number(l.CsApprovedQty)) : null;
    const awardExVat = award ? Number(award.UnitPrice) / (award.IsVatInclusive ? VAT : 1) : null;
    const awardValue = award ? r2(Number(award.Qty) * awardExVat) : null;
    const poValue = poLine ? r2(poLine.ordered * (poLine.price || 0)) : null;
    const avgP = item ? avgPrice.get(item.itemCode) : null;
    const committedValue = poValue ?? awardValue ?? null;
    const estValue = committedValue ?? estValueOf(l, qty, avgP);

    const outcome = rejected ? 'Rejected'
      : poLine && poLine.received > 0 ? (poLine.pending > 0.0001 ? 'Part received' : 'Received')
        : po ? 'PO raised' : award ? 'Awarded' : rfq ? 'Sourcing' : l.HoldReason ? 'Held' : 'Open';

    // Money committed (sent for quotes or further) vs a request nobody acted on yet.
    const progressed = ['Sourcing', 'Awarded', 'PO raised', 'Part received', 'Received'].includes(outcome);
    const flags = [];
    const flag = (code, text, severity) => flags.push({ code, ...FLAG_INFO[code], ...(severity ? { severity } : {}), text });
    const fuel = /PETROL|DIESEL|FUEL/.test(norm(`${item?.itemName || busyName} ${item?.group || ''}`)) || l.OrderType === 'Fuel';
    if (stocked && !fuel && !rejected && at && lv && qty > 0) {
      if (!unitOk) {
        flag('UNIT_MISMATCH', `asked in "${reqUnit}", Busy counts this item in "${busyUnit}" — stock and level checks skipped`);
      } else {
        // Stock the requester could actually draw on: their own store + Central Stores.
        const isCentral = norm(l.MatCenter) === CENTRAL;
        const available = r2(isCentral ? max0(at.central) : max0(at.own) + max0(at.central));
        const where = isCentral ? 'Central Stores' : `${l.MatCenter} + Central Stores`;
        // An order was due only when company stock had fallen to the reorder level.
        const aboveReorder = noUse ? at.company > 0 : at.company > lv.reorderLevel;
        const material = (awardValue ?? poValue ?? estValueOf(l, qty, avgP)) >= MATERIAL_KES;
        if (aboveReorder && available >= qty) {
          const severe = noUse || position?.code === 'above_max';
          flag('STOCK_AVAILABLE', noUse
            ? `${where} held ${available}; the item had no use in the 6 months before, so nothing was due for reorder`
            : `company stock ${at.company} was above the reorder level ${lv.reorderLevel}${lv.maxLevel != null ? ` (max ${lv.maxLevel})` : ''}, and ${where} held ${available} — enough for this request`,
          progressed ? (severe ? 'high' : 'medium') : 'low');
        } else if (noUse && progressed && material) {
          flag('NO_USAGE', 'no use of this item in the 6 months before the request');
        }
        // Fast movers with a short lead time have a maximum below 2 weeks of use —
        // only call it over-ordering when it also leaves more than 2 months of use.
        if (!noUse && lv.maxLevel != null && at.company + qty > lv.maxLevel * 1.1 && material
          && !(avgMonthly > 0 && (at.company + qty) / avgMonthly <= OVER_MONTHS)) {
          flag('OVER_ORDER', `stock ${at.company} + ${qty} asked = ${r2(at.company + qty)}, above the maximum level ${lv.maxLevel}`
            + (avgMonthly > 0 ? ` (${r2((at.company + qty) / avgMonthly)} months of use)` : ''), progressed ? 'medium' : 'low');
        }
      }
    }
    const creator = l.CreatedByUserId;
    const csBy = l.CsDecidedById || l.CentralStoresApprovedByUserId;
    const opsBy = l.OpsDecidedById || l.OpsApprovedByUserId;
    if (creator && (creator === csBy || creator === opsBy)) flag('SELF_APPROVED', `${l.CreatedBy} raised and approved it`);
    else if (csBy && opsBy && csBy === opsBy) flag('SAME_APPROVER', `${l.OpsDecidedBy || l.OpsBy} approved at Central Stores and Ops`);
    if (award && approvedQty != null && Number(award.Qty) > approvedQty * 1.01) flag('AWARD_ABOVE_APPROVED', `approved ${approvedQty}, awarded ${Number(award.Qty)}`);
    if (award && q?.LowestExVat && awardExVat > Number(q.LowestExVat) * 1.01) {
      flag('NOT_LOWEST', `awarded ${r2(awardExVat)} ex VAT to ${award.SupplierName}; lowest ${r2(q.LowestExVat)} from ${q.LowestSupplier}`);
    }
    if (award && q && Number(q.PricedSuppliers) === 1) flag('SINGLE_QUOTE', `only ${award.SupplierName} quoted`);
    if (awardValue != null && poValue != null && Math.abs(poValue - awardValue) > Math.max(1, 0.01 * Math.abs(awardValue))) {
      flag('PO_VS_AWARD', awardValue === 0
        ? `the award shows quantity 0, the PO is ${r2(poValue).toLocaleString()}`
        : `PO ${r2(poValue).toLocaleString()} vs award ${awardValue.toLocaleString()} ex VAT`);
    }
    if (poLine && avgP && poLine.price > avgP * 1.25) flag('PRICE_ABOVE_AVG', `PO price ${poLine.price} vs 12-month average ${r2(avgP)} (+${Math.round((poLine.price / avgP - 1) * 100)}%)`);
    if (poLine && poLine.received > poLine.ordered + 0.0001) flag('OVER_RECEIVED', `received ${poLine.received}, ordered ${poLine.ordered}`);
    if (lpo && !po) flag('PO_NOT_FOUND', `${lpo.BusyPurOrdNo} not found in Busy`);
    const toPo = po ? days(l.ReqDate, po.date) : null;
    if (!rejected && (toPo > 30 || (!po && (l.OpsApprovedAt || l.OpsDecision === 'Approved') && days(l.ReqDate, today) > 30))) {
      flag('SLOW', toPo > 30 ? `PO ${toPo} days after the request` : `approved, no PO after ${days(l.ReqDate, today)} days`);
    }

    return {
      requisitionId: l.RequisitionId, requisitionItemId: l.RequisitionItemId, reqNo: l.BusyOrdNo, date: day,
      factory: l.MatCenter, status: l.Status, source: l.Source, orderType: l.OrderType, outcome,
      item: l.ItemName, busyItem: item?.itemName || null, group: item?.group || l.Category || null,
      unit: reqUnit || busyUnit, busyUnit, unitOk,
      qty, approvedQty, estValue: r2(estValue), committedValue: r2(committedValue),
      stockAtRequest: at, stockNow: now, avgMonthlyUse: avgMonthly, monthsCover: cover,
      useMonths: cons?.months || null,
      levelsThen: lv ? { reorderLevel: lv.reorderLevel, minLevel: lv.minLevel, maxLevel: lv.maxLevel, leadWeeks: item.leadWeeks, leadDefaulted: item.leadDefaulted, max6: cons.max6, avg3: cons.avg3 } : null,
      position,
      // Looking ahead from the request date: if the quantity asked was bought,
      // how long company stock would last at the average use of the time.
      ifBought: at && unitOk && avgMonthly > 0 && qty > 0 ? {
        stockAfter: r2(max0(at.company) + qty),
        months: r2((max0(at.company) + qty) / avgMonthly),
        lastsUntil: ymd(new Date(new Date(day).getTime() + ((max0(at.company) + qty) / avgMonthly) * 30 * DAY)),
        overMax: lv?.maxLevel != null && max0(at.company) + qty > lv.maxLevel ? r2(max0(at.company) + qty - lv.maxLevel) : 0,
      } : null,
      levelsToday: lvl ? {
        reorderLevel: r2(lvl.ReorderLevel), minLevel: r2(lvl.MinimumStockLevel), maxLevel: r2(lvl.MaxStockLevel),
        busyMin: r2(lvl.BusyMinLevel), busyReorder: r2(lvl.BusyReorderLevel), busyMax: r2(lvl.BusyMaxLevel),
      } : null,
      raisedBy: l.CreatedBy || (l.Source === 'Busy' ? 'Busy' : null),
      centralStores: l.CsDecision || l.CentralStoresApprovedAt
        ? { decision: l.CsDecision || 'Approved', qty: l.CsApprovedQty != null ? Math.abs(Number(l.CsApprovedQty)) : null, by: l.CsDecidedBy || l.CentralStoresBy, at: l.CsDecidedAt || l.CentralStoresApprovedAt, reason: l.CsItemRejection || l.CentralStoresRejectionReason }
        : null,
      ops: l.OpsDecision || l.OpsApprovedAt
        ? { decision: l.OpsDecision || (l.Status === 'RejectedByOps' ? 'Rejected' : 'Approved'), qty: l.OpsApprovedQty != null ? Math.abs(Number(l.OpsApprovedQty)) : null, by: l.OpsDecidedBy || l.OpsBy, at: l.OpsDecidedAt || l.OpsApprovedAt, reason: l.OpsItemRejection || l.OpsRejectionReason }
        : null,
      hold: l.HoldReason ? { reason: l.HoldReason, at: l.HeldAt } : null,
      rfq: rfq ? { number: rfq.RFQNumber, sentAt: rfq.FirstSentAt || rfq.IssuedAt, by: rfq.IssuedBy, suppliersAsked: rfq.Dispatches } : null,
      quotes: q ? { suppliers: q.Suppliers, priced: q.PricedSuppliers, lowestExVat: r2(q.LowestExVat), lowestSupplier: q.LowestSupplier } : null,
      award: award ? { supplier: award.SupplierName, qty: Number(award.Qty), unitPrice: r2(award.UnitPrice), vatInclusive: !!award.IsVatInclusive, valueExVat: awardValue, at: rfq?.AwardedAt, by: rfq?.Director } : null,
      po: lpo ? { poNo: lpo.BusyPurOrdNo, found: !!po, date: po?.date || null, approved: po?.approved ?? null, qty: poLine?.ordered ?? null, price: poLine?.price ?? null, value: poValue } : null,
      received: poLine ? { qty: poLine.received, pending: poLine.pending, firstAt: firstReceipt } : null,
      cycleDays: { toOps: days(l.ReqDate, l.OpsDecidedAt || l.OpsApprovedAt), toPo: toPo, toReceipt: days(l.ReqDate, firstReceipt) },
      flags,
    };
  });

  // Possible duplicates: the same item twice on one requisition, or another
  // requisition for the same store within 14 days where the two together
  // would take stock past the maximum level (regular top-ups of a fast mover
  // like sugar are not duplicates).
  const byKey = new Map();
  for (const x of out) {
    if (x.outcome === 'Rejected' || !x.unitOk) continue;
    const k = `${norm(x.factory)}|${norm(x.busyItem || x.item)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(x);
  }
  const live = (x) => !['Open', 'Held'].includes(x.outcome);
  for (const group of byKey.values()) {
    group.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.requisitionItemId - b.requisitionItemId));
    for (let i = 1; i < group.length; i++) {
      const cur = group[i];
      const twin = group.slice(0, i).find((p) => p.requisitionId === cur.requisitionId);
      if (twin) {
        cur.flags.push({ code: 'DUPLICATE', ...FLAG_INFO.DUPLICATE, text: `listed twice on ${cur.reqNo} (${twin.qty} and ${cur.qty})` });
        continue;
      }
      const prev = group.slice(0, i).reverse().find((p) => p.requisitionId !== cur.requisitionId && days(p.date, cur.date) <= 14);
      if (!prev) continue;
      const max = cur.levelsThen?.maxLevel;
      const stock = cur.stockAtRequest?.company || 0;
      const together = r2(stock + prev.qty + cur.qty);
      const use = cur.avgMonthlyUse;
      if (max == null || (together > max && !(use > 0 && together / use <= OVER_MONTHS))) {
        cur.flags.push({
          code: 'DUPLICATE', ...FLAG_INFO.DUPLICATE, severity: live(prev) || live(cur) ? 'medium' : 'low',
          text: `${prev.reqNo} (${prev.date}) asked ${prev.qty} of the same item for ${cur.factory} — ${prev.outcome.toLowerCase()}`
            + (max != null ? `; stock ${stock} + both requests = ${together}, above the maximum level ${max}` : ''),
        });
      }
    }
  }

  return { lines: out, summary: summarize(out), flagInfo: FLAG_INFO };
}

function summarize(lines) {
  const sev = { high: 3, medium: 2, low: 1 };
  const byFactory = new Map();
  const flagCounts = {};
  const reqs = new Set();
  // value = committed (award / PO, ex VAT); "flagged" = has a high or medium flag (low ones are notes).
  let value = 0; let flaggedValue = 0;
  const cyc = { toOps: [], toPo: [], toReceipt: [] };
  for (const l of lines) {
    l.risk = l.flags.reduce((m, x) => Math.max(m, sev[x.severity] || 0), 0);
    reqs.add(l.requisitionId);
    const f = l.factory || '(none)';
    if (!byFactory.has(f)) byFactory.set(f, { factory: f, requisitions: new Set(), lines: 0, flagged: 0, high: 0, value: 0, flaggedValue: 0, rejected: 0, ordered: 0, received: 0 });
    const s = byFactory.get(f);
    s.requisitions.add(l.requisitionId);
    s.lines += 1;
    s.value += l.committedValue || 0;
    value += l.committedValue || 0;
    if (l.outcome === 'Rejected') s.rejected += 1;
    if (l.po) s.ordered += 1;
    if (l.outcome === 'Received' || l.outcome === 'Part received') s.received += 1;
    if (l.risk >= 2) {
      s.flagged += 1; s.flaggedValue += l.committedValue || 0; flaggedValue += l.committedValue || 0;
      if (l.risk === 3) s.high += 1;
    }
    for (const x of l.flags) {
      const c = flagCounts[x.code] || (flagCounts[x.code] = { total: 0, high: 0, medium: 0, low: 0 });
      c.total += 1; c[x.severity] += 1;
    }
    for (const k of Object.keys(cyc)) if (l.cycleDays[k] != null && l.cycleDays[k] >= 0) cyc[k].push(l.cycleDays[k]);
  }
  const avg = (a) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
  return {
    requisitions: reqs.size,
    lines: lines.length,
    flaggedLines: lines.filter((l) => l.risk >= 2).length,
    highRiskLines: lines.filter((l) => l.risk === 3).length,
    value: r2(value), flaggedValue: r2(flaggedValue),
    avgDays: { toOps: avg(cyc.toOps), toPo: avg(cyc.toPo), toReceipt: avg(cyc.toReceipt) },
    flagCounts,
    byFactory: [...byFactory.values()].map((s) => ({ ...s, requisitions: s.requisitions.size, value: r2(s.value), flaggedValue: r2(s.flaggedValue) }))
      .sort((a, b) => b.value - a.value),
  };
}

module.exports = { buildRequisitionAudit, FLAG_INFO };
