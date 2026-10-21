/**
 * Busy Purchase Order builder (2026-10-17)
 *
 * Turns one awarded supplier share into the <PurchaseOrder> XML that
 * Busy's AddVchFromXML accepts (format taken from GetVchXML on real POs,
 * e.g. Pur-2809 / Pur-2836). Busy fills in VchNo / AutoVchNo itself on
 * save — we never send a number.
 *
 * Everything Busy references by name is resolved against Busy first and
 * the push is blocked if any of it is missing, so Busy never has to guess:
 *   supplier  Suppliers.SupplierCode = Master1.Code (MasterType 2)
 *   item      COALESCE(RequisitionItems.ItemCode, ItemName) = Master1.Name (MasterType 6)
 *             — same rule lpo-reconciliation.service.js uses; the main unit
 *             is the item master's CM1 (MasterType 8)
 *   store     Requisitions.MatCenter = Master1.Name (MasterType 11)
 *   tax type  one of the purchase types buyers already use on POs (MasterType 14)
 * Prices and quantities always come from the stored award, never the browser.
 */
const { sql } = require('../db');
const { sql: erpSql } = require('../erpDb');
const config = require('../config');
const { FUEL_ITEMS, FUEL_TAX_TYPE, FUEL_VAT_RATE, fuelItemName } = require('./fuel-order.service');

const PO_VCHTYPE = 13;

// Purchase types used on Busy POs (Aug–Oct 2026: TaxIncl 562, Vat16% 478,
// Exempt 372, VAT/16% 77, VAT/14% 2). Defaults are picked from the quote's
// VAT-inclusive flag; the buyer can override in the push dialog.
const TAX_TYPES = ['VAT/TaxIncl.', 'Vat16%', 'VAT/16%', 'VAT/Exempt', 'VAT/14%'];
// Busy does NOT work the tax out for a voucher saved through the API, so we
// send it the way Busy's own screen stores it (compared against saved POs):
//   inclusive  per-line NettAmount / STAmount / STPercent, no VAT bill sundry
//   exclusive  one "VAT" bill sundry on the net total
// and a "Rounded Off" bill sundry that brings the grand total to a whole number.
const TAX_RATES = {
  'VAT/TaxIncl.': { rate: 16, inclusive: true },
  'Vat16%': { rate: 16, inclusive: false },
  'VAT/16%': { rate: 16, inclusive: false },
  'VAT/Exempt': { rate: 0, inclusive: false },
  'VAT/14%': { rate: 14, inclusive: false },
};
const DEFAULT_TAX_TYPE_INCLUSIVE = 'VAT/TaxIncl.';
const DEFAULT_TAX_TYPE_EXCLUSIVE = 'VAT/16%';

// Busy's narration field (VchOtherInfo.Narration1) is nvarchar(94). The
// leading "[MTS RFQ-...]" tag also lets us spot a PO this system already
// raised if a push is retried after a failure (see findExistingPushedPo).
const NARRATION_MAX = 94;
const narrationTag = (rfqNumber) => `[MTS ${rfqNumber}]`;

const xmlEscape = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** dd-mm-yyyy, the date format Busy's voucher XML uses. */
function busyDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * The award lines this supplier won, straight from our DB.
 * Split awards: QuoteEvaluationItems for (evaluation, supplier).
 * Full (legacy) awards: every available line of the winning quotation.
 */
async function loadAwardLines(pool, { quoteEvaluationId, supplierId, awardType }) {
  const req = pool.request()
    .input('evalId', sql.Int, quoteEvaluationId)
    .input('supplierId', sql.Int, supplierId);

  const result = awardType === 'split'
    ? await req.query(`
        SELECT ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Unit,
               qei.Qty, qei.UnitPrice, li.IsVatInclusive,
               r.MatCenter, r.BusyOrdNo
        FROM dbo.QuoteEvaluationItems qei
        JOIN dbo.QuotationLineItems li ON li.QuotationLineItemId = qei.QuotationLineItemId
        JOIN dbo.RequisitionItems ri   ON ri.RequisitionItemId = qei.RequisitionItemId
        JOIN dbo.Requisitions r        ON r.RequisitionId = ri.RequisitionId
        WHERE qei.QuoteEvaluationId = @evalId AND qei.SupplierId = @supplierId
        ORDER BY ri.RequisitionItemId
      `)
    : await req.query(`
        SELECT ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Unit,
               li.Qty, li.UnitPrice, li.IsVatInclusive,
               r.MatCenter, r.BusyOrdNo
        FROM dbo.QuoteEvaluations ev
        JOIN dbo.Quotations q          ON q.QuotationId = ev.WinningQuotationId
        JOIN dbo.QuotationLineItems li ON li.QuotationId = q.QuotationId
        JOIN dbo.RequisitionItems ri   ON ri.RequisitionItemId = li.RequisitionItemId
        JOIN dbo.Requisitions r        ON r.RequisitionId = ri.RequisitionId
        WHERE ev.QuoteEvaluationId = @evalId AND q.SupplierId = @supplierId
          AND ISNULL(li.IsNotAvailable, 0) = 0
        ORDER BY ri.RequisitionItemId
      `);
  return result.recordset;
}

// Busy's SQL collation is case-insensitive ("f5" finds "F5"), so the JS
// side must be too.
const nameKey = (n) => String(n || '').trim().toLowerCase();

/** Look up Busy masters by name for one MasterType. Returns Map(nameKey -> row). */
async function resolveMastersByName(erpPool, masterType, names, extraCols = '') {
  const unique = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;
  const req = erpPool.request().input('mt', erpSql.SmallInt, masterType);
  unique.forEach((n, i) => req.input(`n${i}`, erpSql.NVarChar(40), n));
  const result = await req.query(`
    SELECT m.Code, LTRIM(RTRIM(m.Name)) AS Name ${extraCols}
    FROM dbo.Master1 m
    ${masterType === 6 ? 'LEFT JOIN dbo.Master1 u ON u.Code = m.CM1 AND u.MasterType = 8' : ''}
    WHERE m.MasterType = @mt AND LTRIM(RTRIM(m.Name)) IN (${unique.map((_, i) => `@n${i}`).join(',')})
  `);
  for (const row of result.recordset) map.set(nameKey(row.Name), row);
  return map;
}

/** Every Busy store (Material Centre) — offered when a requisition's store isn't one. */
async function listBusyStores(erpPool) {
  const result = await erpPool.request()
    .query('SELECT LTRIM(RTRIM(Name)) AS Name FROM dbo.Master1 WHERE MasterType = 11 ORDER BY Name');
  return result.recordset.map((r) => r.Name);
}

/**
 * Everything needed to raise the PO, fully resolved against Busy, plus a
 * list of blocking problems. `xml` is only built when there are none.
 */
async function buildPurchaseOrder(pool, erpPool, {
  rfqId, quoteEvaluationId, supplierId, awardType, taxType, storeOverride, seriesName, date = new Date(),
}) {
  const problems = [];

  const head = await pool.request()
    .input('rfqId', sql.Int, rfqId)
    .input('supplierId', sql.Int, supplierId)
    .query(`
      SELECT rfq.RFQNumber, s.SupplierName, s.SupplierCode
      FROM dbo.RFQs rfq CROSS JOIN dbo.Suppliers s
      WHERE rfq.RFQId = @rfqId AND s.SupplierId = @supplierId
    `);
  if (head.recordset.length === 0) return { problems: ['RFQ or supplier not found'] };
  const { RFQNumber: rfqNumber, SupplierName: supplierName, SupplierCode } = head.recordset[0];

  // Supplier → Busy party (exact code; no name guessing for a financial document)
  const partyCode = parseInt(String(SupplierCode || '').trim(), 10);
  let party = null;
  if (!Number.isFinite(partyCode) || partyCode <= 0) {
    problems.push(`Supplier "${supplierName}" has no Busy party code — set its Supplier Code to the Busy account code first.`);
  } else {
    const p = await erpPool.request().input('code', erpSql.Int, partyCode)
      .query('SELECT Code, LTRIM(RTRIM(Name)) AS Name FROM dbo.Master1 WHERE Code = @code AND MasterType = 2');
    party = p.recordset[0] || null;
    if (!party) problems.push(`Busy has no party with code ${partyCode} (supplier "${supplierName}").`);
  }

  const awardLines = await loadAwardLines(pool, { quoteEvaluationId, supplierId, awardType });
  if (awardLines.length === 0) problems.push('No awarded items found for this supplier.');

  const busyItemName = (l) => String(l.ItemCode || l.ItemName || '').trim();
  const [items, stores, taxTypes] = await Promise.all([
    resolveMastersByName(erpPool, 6, awardLines.map(busyItemName), ', LTRIM(RTRIM(u.Name)) AS UnitName'),
    resolveMastersByName(erpPool, 11, [...awardLines.map((l) => l.MatCenter), storeOverride]),
    resolveMastersByName(erpPool, 14, TAX_TYPES),
  ]);
  // Store chosen by the buyer for lines whose requisition store isn't a Busy store.
  const overrideStore = storeOverride ? stores.get(nameKey(storeOverride)) : null;
  if (storeOverride && !overrideStore) problems.push(`Store "${storeOverride}" does not exist in Busy.`);

  const vatFlags = new Set(awardLines.map((l) => (l.IsVatInclusive ? 'incl' : 'excl')));
  if (vatFlags.size > 1) {
    problems.push('This quote mixes VAT-inclusive and VAT-exclusive prices. Raise this one in Busy by hand.');
  }
  const suggestedTaxType = vatFlags.has('incl') ? DEFAULT_TAX_TYPE_INCLUSIVE : DEFAULT_TAX_TYPE_EXCLUSIVE;
  const chosenTaxType = taxType || suggestedTaxType;
  const taxInfo = TAX_RATES[chosenTaxType];
  if (!taxInfo || !taxTypes.has(nameKey(chosenTaxType))) {
    problems.push(`Tax type "${chosenTaxType}" is not a Busy purchase type.`);
  } else if (vatFlags.size === 1) {
    // Prices that already include VAT must not have VAT added on top, and vice versa.
    if (vatFlags.has('incl') && !taxInfo.inclusive) {
      problems.push(`The quote prices include VAT — choose "${DEFAULT_TAX_TYPE_INCLUSIVE}" so VAT is not added again.`);
    } else if (vatFlags.has('excl') && taxInfo.inclusive) {
      problems.push(`The quote prices exclude VAT — "${chosenTaxType}" would treat them as VAT-inclusive. Choose another tax type.`);
    }
  }
  const taxRate = taxInfo?.rate || 0;
  const taxInclusive = !!taxInfo?.inclusive;

  let needsStore = false;
  const lines = awardLines.map((l, i) => {
    const name = busyItemName(l);
    const item = items.get(nameKey(name));
    const ownStore = stores.get(nameKey(l.MatCenter));
    const store = ownStore || overrideStore;
    const qty = Number(l.Qty) || 0;
    const price = Number(l.UnitPrice) || 0;
    if (!item) problems.push(`Item "${name}" does not exist in Busy.`);
    if (!ownStore) needsStore = true;
    if (!store) problems.push(`Store "${l.MatCenter || '(none)'}" for "${name}" does not exist in Busy — choose a Busy store.`);
    if (qty <= 0 || price <= 0) problems.push(`Item "${name}" has no quantity or price on the award.`);
    const amount = round2(qty * price);
    const netAmount = taxInclusive ? round2(amount / (1 + taxRate / 100)) : amount;
    return {
      srNo: i + 1,
      requisitionItemId: l.RequisitionItemId,
      itemName: item?.Name || name,
      unitName: item?.UnitName || null,
      store: store?.Name || l.MatCenter || null,
      requisitionStore: l.MatCenter || null,
      qty,
      price,
      amount,
      netAmount,
      taxAmount: taxInclusive ? round2(amount - netAmount) : 0,
      vatInclusive: !!l.IsVatInclusive,
      requisition: l.BusyOrdNo,
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const vat = taxInclusive
    ? round2(lines.reduce((s, l) => s + l.taxAmount, 0))
    : round2(subtotal * taxRate / 100);
  const grossTotal = taxInclusive ? subtotal : round2(subtotal + vat);
  const total = Math.round(grossTotal);
  const roundOff = round2(total - grossTotal);

  const reqNos = [...new Set(awardLines.map((l) => String(l.BusyOrdNo || '').trim()).filter(Boolean))];
  const narration = `${narrationTag(rfqNumber)} ${reqNos.join(', ')}`.trim().slice(0, NARRATION_MAX);

  const po = {
    rfqNumber,
    supplierName,
    party,
    taxType: chosenTaxType,
    taxRate,
    taxInclusive,
    suggestedTaxType,
    taxTypes: TAX_TYPES.filter((t) => taxTypes.has(nameKey(t))),
    needsStore,
    storeOverride: overrideStore?.Name || null,
    date: busyDate(date),
    narration,
    lines,
    subtotal,
    vat,
    roundOff,
    total, // grand total Busy will hold, incl. VAT
    problems: [...new Set(problems)],
  };

  if (po.problems.length === 0) {
    const sundries = [];
    if (!taxInclusive && taxRate > 0) {
      sundries.push(`<BSName>VAT</BSName><PercentVal>${taxRate}</PercentVal><PercentOperatedOn>${subtotal}</PercentOperatedOn><Amt>${vat}</Amt>`);
    }
    if (roundOff !== 0) {
      sundries.push(`<BSName>Rounded Off (${roundOff > 0 ? '+' : '-'})</BSName><Amt>${Math.abs(roundOff)}</Amt>`);
    }
    po.xml = '<PurchaseOrder>'
      + `<VchSeriesName>${xmlEscape(seriesName)}</VchSeriesName>`
      + `<Date>${po.date}</Date><VchType>${PO_VCHTYPE}</VchType>`
      + `<STPTName>${xmlEscape(po.taxType)}</STPTName>`
      + `<MasterName1>${xmlEscape(party.Name)}</MasterName1>`
      + `<VchOtherInfoDetails><Narration1>${xmlEscape(narration)}</Narration1></VchOtherInfoDetails>`
      + '<ItemEntries>'
      + lines.map((l) => '<ItemDetail>'
        + `<SrNo>${l.srNo}</SrNo><ItemName>${xmlEscape(l.itemName)}</ItemName>`
        + (l.unitName ? `<UnitName>${xmlEscape(l.unitName)}</UnitName>` : '')
        + `<Qty>${l.qty}</Qty><Price>${l.price}</Price><Amt>${l.amount}</Amt>`
        + `<NettAmount>${l.netAmount}</NettAmount>`
        + (taxInclusive
          ? `<STAmount>${l.taxAmount}</STAmount><STPercent>${taxRate}</STPercent><TaxBeforeSurcharge>${l.taxAmount}</TaxBeforeSurcharge>`
          : '')
        + `<MC>${xmlEscape(l.store)}</MC>`
        + '</ItemDetail>').join('')
      + '</ItemEntries>'
      + (sundries.length
        ? `<BillSundries>${sundries.map((s, i) => `<BSDetail><SrNo>${i + 1}</SrNo>${s}</BSDetail>`).join('')}</BillSundries>`
        : '')
      + '</PurchaseOrder>';
  }
  return po;
}

/**
 * Busy PO for a Transport fuel requisition (2026-10-19) — no RFQ/award.
 * Shaped like the fuel POs Busy users raise (e.g. Pur-2745---2026-27): item
 * "Motor Vehicle fuel-diesel/petrol", store = the vehicle, the vehicle in the
 * narration, tax type VAT/TaxIncl. at 8%. The requester's unit price is taken
 * as the pump price incl. VAT. Litres often aren't known yet (0): the line is
 * then 1 unit at that price, the way Busy users enter fuel, and the narration
 * says the litres are open. The supplier is picked by Procurement.
 */
async function buildFuelPurchaseOrder(pool, erpPool, { requisitionId, supplierId, seriesName, date = new Date() }) {
  const problems = [];

  const head = await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT RequisitionId, BusyOrdNo, MatCenter, Vehicle, OrderType, Status
    FROM dbo.Requisitions WHERE RequisitionId = @id`);
  const reqn = head.recordset[0];
  if (!reqn) return { problems: ['Requisition not found'] };
  if (reqn.OrderType !== 'Fuel') return { problems: ['Only fuel orders can be raised in Busy straight from the requisition.'] };

  let supplierName = null;
  let party = null;
  if (!supplierId) {
    problems.push('Choose the fuel supplier.');
  } else {
    const s = await pool.request().input('sid', sql.Int, supplierId)
      .query('SELECT SupplierName, SupplierCode FROM dbo.Suppliers WHERE SupplierId = @sid');
    const sup = s.recordset[0];
    if (!sup) problems.push('Supplier not found.');
    else {
      supplierName = sup.SupplierName;
      const partyCode = parseInt(String(sup.SupplierCode || '').trim(), 10);
      if (!Number.isFinite(partyCode) || partyCode <= 0) {
        problems.push(`Supplier "${supplierName}" has no Busy party code — set its Supplier Code to the Busy account code first.`);
      } else {
        const p = await erpPool.request().input('code', erpSql.Int, partyCode)
          .query('SELECT Code, LTRIM(RTRIM(Name)) AS Name FROM dbo.Master1 WHERE Code = @code AND MasterType = 2');
        party = p.recordset[0] || null;
        if (!party) problems.push(`Busy has no party with code ${partyCode} (supplier "${supplierName}").`);
      }
    }
  }

  const itemRows = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT RequisitionItemId, ItemName, ItemCode, Qty, UnitPrice
    FROM dbo.RequisitionItems WHERE RequisitionId = @id ORDER BY RequisitionItemId`)).recordset;
  if (itemRows.length === 0) problems.push('The requisition has no items.');

  const names = itemRows.map((r) => fuelItemName(r.ItemCode || r.ItemName) || String(r.ItemCode || r.ItemName).trim());
  const [items, stores, taxTypes] = await Promise.all([
    resolveMastersByName(erpPool, 6, names, ', LTRIM(RTRIM(u.Name)) AS UnitName'),
    resolveMastersByName(erpPool, 11, [reqn.MatCenter]),
    resolveMastersByName(erpPool, 14, [FUEL_TAX_TYPE]),
  ]);
  const store = stores.get(nameKey(reqn.MatCenter));
  if (!store) problems.push(`Store "${reqn.MatCenter || '(none)'}" does not exist in Busy.`);
  if (!taxTypes.has(nameKey(FUEL_TAX_TYPE))) problems.push(`Tax type "${FUEL_TAX_TYPE}" is not a Busy purchase type.`);

  let litresOpen = false;
  const lines = itemRows.map((r, i) => {
    const name = names[i];
    const item = items.get(nameKey(name));
    if (!fuelItemName(name)) problems.push(`"${name}" is not a fuel item.`);
    else if (!item) problems.push(`Item "${name}" does not exist in Busy.`);
    const litres = Number(r.Qty) || 0;
    const price = Number(r.UnitPrice) || 0;
    if (price <= 0) problems.push(`"${name}" has no unit price.`);
    if (litres <= 0) litresOpen = true;
    const qty = litres > 0 ? litres : 1;
    const amount = round2(qty * price);
    const netAmount = round2(amount / (1 + FUEL_VAT_RATE / 100));
    return {
      srNo: i + 1,
      requisitionItemId: r.RequisitionItemId,
      itemName: item?.Name || name,
      unitName: item?.UnitName || null,
      store: store?.Name || reqn.MatCenter,
      litres,
      qty,
      price,
      amount,
      netAmount,
      taxAmount: round2(amount - netAmount),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const vat = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  const total = Math.round(subtotal);
  const roundOff = round2(total - subtotal);
  const priceNote = lines.length === 1 ? ` @${lines[0].price}/L` : '';
  const narration = `${narrationTag(reqn.BusyOrdNo)} ${reqn.Vehicle || ''}${litresOpen ? ` litres open${priceNote}` : ''}`
    .replace(/\s+/g, ' ').trim().slice(0, NARRATION_MAX);

  const po = {
    requisitionNo: reqn.BusyOrdNo,
    requisitionStatus: reqn.Status,
    vehicle: reqn.Vehicle,
    supplierName,
    party,
    taxType: FUEL_TAX_TYPE,
    taxRate: FUEL_VAT_RATE,
    taxInclusive: true,
    store: store?.Name || reqn.MatCenter,
    litresOpen,
    date: busyDate(date),
    narration,
    lines,
    subtotal,
    vat,
    roundOff,
    total,
    problems: [...new Set(problems)],
  };

  if (po.problems.length === 0) {
    const sundries = roundOff !== 0
      ? [`<BSName>Rounded Off (${roundOff > 0 ? '+' : '-'})</BSName><Amt>${Math.abs(roundOff)}</Amt>`]
      : [];
    po.xml = '<PurchaseOrder>'
      + `<VchSeriesName>${xmlEscape(seriesName)}</VchSeriesName>`
      + `<Date>${po.date}</Date><VchType>${PO_VCHTYPE}</VchType>`
      + `<STPTName>${xmlEscape(po.taxType)}</STPTName>`
      + `<MasterName1>${xmlEscape(party.Name)}</MasterName1>`
      + `<VchOtherInfoDetails><Narration1>${xmlEscape(narration)}</Narration1></VchOtherInfoDetails>`
      + '<ItemEntries>'
      + lines.map((l) => '<ItemDetail>'
        + `<SrNo>${l.srNo}</SrNo><ItemName>${xmlEscape(l.itemName)}</ItemName>`
        + (l.unitName ? `<UnitName>${xmlEscape(l.unitName)}</UnitName>` : '')
        + `<Qty>${l.qty}</Qty><Price>${l.price}</Price><Amt>${l.amount}</Amt>`
        + `<NettAmount>${l.netAmount}</NettAmount>`
        + `<STAmount>${l.taxAmount}</STAmount><STPercent>${FUEL_VAT_RATE}</STPercent><TaxBeforeSurcharge>${l.taxAmount}</TaxBeforeSurcharge>`
        + `<MC>${xmlEscape(l.store)}</MC>`
        + '</ItemDetail>').join('')
      + '</ItemEntries>'
      + (sundries.length
        ? `<BillSundries>${sundries.map((s, i) => `<BSDetail><SrNo>${i + 1}</SrNo>${s}</BSDetail>`).join('')}</BillSundries>`
        : '')
      + '</PurchaseOrder>';
  }
  return po;
}

/**
 * Our suppliers that Busy users have raised fuel POs to (last 12 months),
 * most used first — offered first when Procurement picks the fuel supplier.
 */
async function listFuelSuppliers(pool, erpPool) {
  const req = erpPool.request();
  const names = Object.keys(FUEL_ITEMS);
  names.forEach((n, i) => req.input(`f${i}`, erpSql.NVarChar(40), n));
  const busy = (await req.query(`
    SELECT t1.MasterCode1 AS PartyCode, COUNT(DISTINCT t1.VchCode) AS Pos
    FROM dbo.Tran1 t1
    JOIN dbo.Tran2 t2 ON t2.VchCode = t1.VchCode AND t2.RecType IN (4, 15)
    JOIN dbo.Master1 i ON i.Code = t2.MasterCode1
    WHERE t1.VchType = ${PO_VCHTYPE} AND t1.[Date] >= DATEADD(month, -12, GETDATE())
      AND LTRIM(RTRIM(i.Name)) IN (${names.map((_, i) => `@f${i}`).join(',')})
    GROUP BY t1.MasterCode1`)).recordset;
  if (busy.length === 0) return [];
  const ours = (await pool.request().query(
    'SELECT SupplierId, SupplierName, SupplierCode FROM dbo.Suppliers WHERE IsActive = 1 AND SupplierCode IS NOT NULL')).recordset;
  const posByCode = new Map(busy.map((b) => [b.PartyCode, b.Pos]));
  return ours
    .map((s) => ({ ...s, busyFuelPos: posByCode.get(parseInt(String(s.SupplierCode).trim(), 10)) || 0 }))
    .filter((s) => s.busyFuelPos > 0)
    .sort((a, b) => b.busyFuelPos - a.busyFuelPos);
}

/**
 * A Busy PO this system already pushed for this RFQ + supplier but which
 * isn't linked yet (e.g. Busy saved it, then our side failed). Found by
 * the narration tag, so a retry links it instead of raising a second PO.
 */
async function findExistingPushedPo(erpPool, { rfqNumber, partyCode }) {
  const result = await erpPool.request()
    .input('vchType', erpSql.Int, PO_VCHTYPE)
    .input('party', erpSql.Int, partyCode)
    .input('tag', erpSql.NVarChar(100), narrationTag(rfqNumber))
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(t1.VchNo)) AS VchNo
      FROM dbo.Tran1 t1
      JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
      -- prefix compare, not LIKE: "[" is a LIKE wildcard
      WHERE t1.VchType = @vchType AND t1.MasterCode1 = @party AND LEFT(oi.Narration1, LEN(@tag)) = @tag
      ORDER BY t1.VchCode DESC
    `);
  return result.recordset[0]?.VchNo || null;
}

/**
 * Puts a PO we just saved into Busy's "Vouchers to be approved" list.
 *
 * Busy's COM session logs in as Supervisor, a super user, so AddVchFromXML
 * always saves the PO already approved and ignores an <ApprovalStatus> tag.
 * A PO a normal Busy user saves for approval differs only in these flags
 * (compared against Pur-2847): Tran1.ApprovalStatus 1 -> 2 and the line
 * RecTypes 4 -> 15 (item) and 3 -> 10 (bill sundry). Busy itself flips them
 * back on approval. Only call this straight after our own save.
 */
async function markPendingApproval(erpPool, vchCode) {
  const tx = new erpSql.Transaction(erpPool);
  await tx.begin();
  try {
    const t1 = await tx.request()
      .input('vch', erpSql.Int, vchCode)
      .input('vchType', erpSql.Int, PO_VCHTYPE)
      .query('UPDATE dbo.Tran1 SET ApprovalStatus = 2 WHERE VchCode = @vch AND VchType = @vchType');
    if (t1.rowsAffected[0] !== 1) throw new Error(`PO VchCode ${vchCode} not found`);
    await tx.request().input('vch', erpSql.Int, vchCode).query(
      'UPDATE dbo.Tran2 SET RecType = CASE RecType WHEN 4 THEN 15 WHEN 3 THEN 10 ELSE RecType END WHERE VchCode = @vch AND RecType IN (3, 4)');
    // the pending-order references Busy keeps for the PO are flagged too
    await tx.request().input('vch', erpSql.Int, vchCode).query(
      'UPDATE dbo.Tran3 SET ApprovalStatus = 2, Status = 2 WHERE VchCode = @vch');
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/**
 * Busy's COM session always logs in as Supervisor, so Busy's "Added by"
 * (BusyUserLog, written when the voucher is saved) names Supervisor. Re-point
 * those entries at the Busy login of the person who raised the PO here.
 * BusyUserLog lives in the Busy company database, not the year database
 * (BusyComp0006_db12026 -> BusyComp0006_db).
 */
const busyCompanyDb = () => process.env.BUSY_COMPANY_DB
  || String(config.erpDb.database).replace(/1\d{4}$/, '');

/** Busy login names (UserPreferences.Name), for linking app users. */
async function listBusyUsers(erpPool) {
  const result = await erpPool.request()
    .query(`SELECT LTRIM(RTRIM(Name)) AS Name FROM [${busyCompanyDb()}].dbo.UserPreferences ORDER BY Name`);
  return result.recordset.map((r) => r.Name);
}

/** The exact Busy login name for `name` (case-insensitive), or null if Busy has no such user. */
async function resolveBusyUser(erpPool, name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const result = await erpPool.request()
    .input('n', erpSql.NVarChar(50), wanted)
    .query(`SELECT TOP 1 LTRIM(RTRIM(Name)) AS Name FROM [${busyCompanyDb()}].dbo.UserPreferences WHERE LTRIM(RTRIM(Name)) = @n`);
  return result.recordset[0]?.Name || null;
}

async function attributeToBusyUser(erpPool, { vchCode, vchNo, busyUserName }) {
  await erpPool.request()
    .input('vch', erpSql.Int, vchCode)
    .input('vchNo', erpSql.NVarChar(60), String(vchNo).trim())
    .input('user', erpSql.NVarChar(50), busyUserName)
    .query(`UPDATE [${busyCompanyDb()}].dbo.BusyUserLog SET UserName = @user
            WHERE WorkedOn = 2 AND L1 = @vch AND LTRIM(RTRIM(S2)) = @vchNo AND UserName = 'Supervisor'`);
}

module.exports = {
  PO_VCHTYPE, TAX_TYPES, buildPurchaseOrder, buildFuelPurchaseOrder, listFuelSuppliers, findExistingPushedPo, listBusyStores,
  markPendingApproval, listBusyUsers, resolveBusyUser, attributeToBusyUser,
};
