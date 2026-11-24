/**
 * Direct-supply orders (2026-11-24) — sawdust for F8, and any item listed in
 * AppSettings 'directSupply.items'.
 *
 * How it is bought (verified in Busy, FY 2026-27):
 *   item       "SAW DUST IN TONNES" (Master1 6, code 5603, unit "ton",
 *              group RAW MATERIALS), store F8
 *   suppliers  13 standing parties (Dhanak, Margaret Chaina, Mijengo, Raymo,
 *              Billy Munyuko, Welding Funiture & Chei, Simon Mbugua, Millicent
 *              Wairimu, Zachariah Zipros, Dominic Rono, Geoffrey Gathuki, Zen
 *              Foam, Franco & Sons) — every one already in Suppliers with
 *              its Busy code
 *   orders     one requisition -> one Busy PO of 50-100 t per supplier
 *              (e.g. REQ-20261117-0006 -> Pur-3318 Zachariah 100 t,
 *              Pur-3319 Dhanak 50 t), the requisition number in the narration
 *   price      each supplier's own standing price, carried from its last PO
 *              (Dhanak 3100, Mijengo 2000 + VAT 16%, the rest 3000 VAT/Exempt).
 *              Busy holds no party-wise price list (no price-list table is in
 *              use); its PO screen carries the party's last rate for the item —
 *              that is the rule used here.
 *   delivery   10-15 t trucks, each a GRN (VchType 4) referencing the PO line
 *              through Tran3 (RecType 4: Method 1 = the order, Method 2 = each
 *              receipt); e.g. Pur-3010 50 t = 5 GRNs over 3 weeks
 *
 * So Procurement raises the POs straight from the requisition (no RFQ), and
 * the production side plans which supplier delivers on which day
 * (DirectSupplyPlan). Arrivals are read live: gate entries
 * (DeliveryEntries / DeliveryEntryItems.BusyItemCode) and Busy GRNs.
 */
const { getPool, sql } = require('../db');
const { getErpPool, sql: erpSql } = require('../erpDb');
const { getDirectSupplyItems } = require('./settings.service');

const PO_VCHTYPE = 13;
const GRN_VCHTYPE = 4;
// A PO line counts as open while more than this is still to come (tonnes) —
// weighbridge tickets leave a few kilos either side of the ordered quantity.
const OPEN_TOLERANCE = 0.1;
// How far back Busy POs are looked at for standing suppliers / open orders.
const STANDING_MONTHS = 12;
const ORDERS_DAYS = 180;
// A PO older than this with nothing received for STALE_IDLE_DAYS is shown as
// an old balance, not as an open order: Busy keeps a few tonnes pending on
// finished POs for months (e.g. Mijengo Pur-1303, July).
const STALE_AGE_DAYS = 45;
const STALE_IDLE_DAYS = 30;

const key = (s) => String(s || '').trim().toLowerCase();
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/** The configured direct-supply item matching a requisition line name, or null. */
async function directItemFor(name) {
  const k = key(name);
  if (!k) return null;
  const items = await getDirectSupplyItems();
  return items.find((i) => key(i) === k) || null;
}

/** Busy item master (Code, Name, Unit) for a direct-supply item name. */
async function resolveItem(erpPool, itemName) {
  const r = await erpPool.request().input('n', erpSql.NVarChar(40), String(itemName).trim()).query(`
    SELECT TOP 1 m.Code, LTRIM(RTRIM(m.Name)) AS Name, LTRIM(RTRIM(u.Name)) AS Unit, m.D4 AS MasterPrice
    FROM dbo.Master1 m LEFT JOIN dbo.Master1 u ON u.Code = m.CM1 AND u.MasterType = 8
    WHERE m.MasterType = 6 AND LTRIM(RTRIM(m.Name)) = @n`);
  return r.recordset[0] || null;
}

/**
 * A requisition quantity in the Busy unit (tonnes). Clerks type sawdust as
 * "50 Tns", "50 ton", "50000 Kgs" and sometimes "50 Kgs" meaning 50 t, so:
 * kilos are divided by 1,000, and a kilo figure under 1,000 is flagged as a
 * likely unit slip (the figure is then shown as tonnes for Procurement to check).
 */
function toBusyUnit(qty, unit, busyUnit) {
  const q = Number(qty) || 0;
  const u = key(unit).replace(/\./g, '');
  const target = key(busyUnit);
  const isTonneUnit = (x) => /^(t|ton|tons|tonne|tonnes|tns|tn|mt)$/.test(x);
  if (/^(kg|kgs|kilo|kilos|kilograms?)$/.test(u) && isTonneUnit(target)) {
    if (q < 1000) return { qty: q, note: `${q} ${unit} looks like tonnes typed as kilos — taken as ${q} ${busyUnit}; check with the requester.` };
    return { qty: round3(q / 1000), note: null };
  }
  return { qty: q, note: null };
}

/**
 * The requisition with each line marked direct-supply or not. F8 requisitions
 * mix direct items (sawdust, offcuts) with others (firewood): the direct
 * lines are ordered here, the rest go through the RFQ path as before.
 * Returns null when not found.
 */
async function loadDirectRequisition(pool, requisitionId) {
  const head = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT RequisitionId, BusyOrdNo, BusyDate, MatCenter, Status, OrderType, RFQId, CreatedAt
    FROM dbo.Requisitions WHERE RequisitionId = @id`)).recordset[0];
  if (!head) return null;
  const rows = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT RequisitionItemId, ItemName, ItemCode, Qty, Unit, RFQId, DirectOrderedAt, DirectPurOrdNos
    FROM dbo.RequisitionItems WHERE RequisitionId = @id ORDER BY RequisitionItemId`)).recordset;
  const lines = await Promise.all(rows.map(async (l) => ({ ...l, directItem: await directItemFor(l.ItemCode || l.ItemName) })));
  const directItems = [...new Set(lines.map((l) => l.directItem).filter(Boolean))];
  return {
    ...head,
    lines,
    directItems,
    isDirect: directItems.length > 0,
    allDirect: lines.length > 0 && lines.every((l) => l.directItem),
  };
}

/**
 * Close the direct lines of one item on a requisition (ordered in full, or
 * the buyer said nothing more is to be ordered) and, once nothing is left on
 * the requisition at all, mark it Reconciled. Returns whether the whole
 * requisition is now done.
 */
async function closeDirectLines(pool, requisitionId, itemNames, ordnos) {
  const names = [...new Set(itemNames.map((n) => String(n).trim().toUpperCase()).filter(Boolean))];
  if (names.length) {
    const req = pool.request()
      .input('id', sql.Int, requisitionId)
      .input('nos', sql.NVarChar(200), [...new Set(ordnos)].join(', ').slice(0, 200) || null);
    names.forEach((n, i) => req.input(`n${i}`, sql.NVarChar(100), n));
    await req.query(`
      UPDATE dbo.RequisitionItems
      SET DirectOrderedAt = SYSUTCDATETIME(),
          DirectPurOrdNos = LEFT(CONCAT(NULLIF(DirectPurOrdNos, '') + ', ', @nos), 200)
      WHERE RequisitionId = @id AND DirectOrderedAt IS NULL
        AND UPPER(LTRIM(RTRIM(COALESCE(ItemCode, ItemName)))) IN (${names.map((_, i) => `@n${i}`).join(',')})`);
  }
  // Done when every line is either ordered directly or covered by an RFQ that
  // has itself been reconciled (its award PO raised).
  const left = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT COUNT(*) AS n FROM dbo.RequisitionItems ri
    WHERE ri.RequisitionId = @id AND ri.DirectOrderedAt IS NULL
      AND NOT (ri.RFQId IS NOT NULL AND EXISTS (SELECT 1 FROM dbo.LPOReconciliation lr WHERE lr.RFQId = ri.RFQId))`)).recordset[0].n;
  if (left === 0) {
    await pool.request().input('id', sql.Int, requisitionId).query(
      "UPDATE dbo.Requisitions SET Status = 'Reconciled', UpdatedAt = GETUTCDATE() WHERE RequisitionId = @id AND Status <> 'Reconciled'");
  }
  return left === 0;
}

/** Our Suppliers rows keyed by Busy party code. */
async function suppliersByBusyCode(pool, codes) {
  const unique = [...new Set(codes.filter((c) => Number.isFinite(c) && c > 0))];
  const map = new Map();
  if (!unique.length) return map;
  const req = pool.request();
  unique.forEach((c, i) => req.input(`c${i}`, sql.VarChar(20), String(c)));
  const rows = (await req.query(`
    SELECT SupplierId, SupplierName, SupplierCode, Phone, IsActive FROM dbo.Suppliers
    WHERE LTRIM(RTRIM(SupplierCode)) IN (${unique.map((_, i) => `@c${i}`).join(',')})
    ORDER BY IsActive DESC, SupplierId`)).recordset;
  for (const r of rows) {
    const c = parseInt(String(r.SupplierCode).trim(), 10);
    if (!map.has(c)) map.set(c, r); // prefer the active / oldest record
  }
  return map;
}

/**
 * Busy PO lines for the item over the last `days`, each with what has been
 * received against it (Tran3 RecType 4 Method 2) and the balance.
 */
async function loadBusyOrders(erpPool, itemCode, { days = ORDERS_DAYS, partyCode } = {}) {
  const req = erpPool.request()
    .input('item', erpSql.Int, itemCode)
    .input('days', erpSql.Int, days)
    .input('vchType', erpSql.Int, PO_VCHTYPE);
  if (partyCode) req.input('party', erpSql.Int, partyCode);
  const rows = (await req.query(`
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.MasterCode1 AS PartyCode,
           LTRIM(RTRIM(p.Name)) AS Party, t1.ApprovalStatus, LTRIM(RTRIM(oi.Narration1)) AS Narration,
           LTRIM(RTRIM(st.Name)) AS TaxType, LTRIM(RTRIM(mc.Name)) AS Store,
           ord.Qty AS Ordered, ord.Price, ISNULL(rcv.Qty, 0) AS Received, rcv.LastReceived, ISNULL(rcv.Grns, 0) AS Grns
    FROM dbo.Tran1 t1
    JOIN (SELECT VchCode, SUM(ABS(D1)) AS Qty, MAX(D2) AS Price, MAX(MasterCode2) AS StoreCode
          FROM dbo.Tran2 WHERE RecType IN (4, 15) AND MasterCode1 = @item GROUP BY VchCode) ord ON ord.VchCode = t1.VchCode
    LEFT JOIN dbo.Master1 p  ON p.Code = t1.MasterCode1
    LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1
    LEFT JOIN dbo.Master1 mc ON mc.Code = ord.StoreCode
    LEFT JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
    OUTER APPLY (
      SELECT SUM(ABS(x.Value1)) AS Qty, MAX(t.[Date]) AS LastReceived, COUNT(DISTINCT x.VchCode) AS Grns
      FROM dbo.Tran3 x JOIN dbo.Tran1 t ON t.VchCode = x.VchCode
      WHERE x.RecType = 4 AND x.Method = 2 AND x.MasterCode1 = @item
        AND x.RefCode IN (SELECT o.RefCode FROM dbo.Tran3 o
                          WHERE o.VchCode = t1.VchCode AND o.RecType = 4 AND o.Method = 1 AND o.MasterCode1 = @item)
    ) rcv
    WHERE t1.VchType = @vchType AND t1.[Date] >= DATEADD(day, -@days, CAST(GETDATE() AS date))
      ${partyCode ? 'AND t1.MasterCode1 = @party' : ''}
    ORDER BY t1.[Date] DESC, t1.VchCode DESC`)).recordset;
  return rows.map((r) => {
    const ordered = round3(r.Ordered);
    const received = round3(r.Received);
    const balance = round3(Math.max(0, ordered - received));
    const daysOld = (Date.now() - new Date(r.Date).getTime()) / 86400000;
    const idleDays = r.LastReceived ? (Date.now() - new Date(r.LastReceived).getTime()) / 86400000 : daysOld;
    const stale = balance > OPEN_TOLERANCE && daysOld > STALE_AGE_DAYS && idleDays > STALE_IDLE_DAYS;
    return {
      vchCode: r.VchCode, ordno: r.VchNo, date: r.Date, partyCode: r.PartyCode, party: r.Party,
      approvalStatus: r.ApprovalStatus, approvalLabel: r.ApprovalStatus === 2 ? 'Pending approval' : 'Approved',
      narration: r.Narration || '', taxType: r.TaxType, store: r.Store,
      price: Number(r.Price) || 0, ordered, received, balance, grns: r.Grns, lastReceived: r.LastReceived,
      open: balance > OPEN_TOLERANCE && !stale,
      stale,
    };
  });
}

const REQ_NO_RE = /REQ-\d{8}-\d{4}/i;

/**
 * Standing suppliers for the item — every Busy party with a PO for it in the
 * last 12 months — with the standing price and tax type from its LAST PO
 * (Busy's own rule), its open balance and our Suppliers record.
 */
async function standingSuppliers(pool, erpPool, item) {
  const rows = (await erpPool.request()
    .input('item', erpSql.Int, item.Code)
    .input('months', erpSql.Int, STANDING_MONTHS)
    .input('vchType', erpSql.Int, PO_VCHTYPE)
    .query(`
      WITH po AS (
        SELECT t1.VchCode, t1.MasterCode1 AS PartyCode, t1.[Date], LTRIM(RTRIM(t1.VchNo)) AS VchNo,
               t2.D2 AS Price, LTRIM(RTRIM(st.Name)) AS TaxType,
               ROW_NUMBER() OVER (PARTITION BY t1.MasterCode1 ORDER BY t1.[Date] DESC, t1.VchCode DESC) AS rn
        FROM dbo.Tran1 t1
        JOIN dbo.Tran2 t2 ON t2.VchCode = t1.VchCode AND t2.RecType IN (4, 15) AND t2.MasterCode1 = @item
        LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1
        WHERE t1.VchType = @vchType AND t1.[Date] >= DATEADD(month, -@months, GETDATE()) AND t2.D2 > 0
      )
      SELECT p.PartyCode, LTRIM(RTRIM(m.Name)) AS Party, p.VchNo AS LastPoNo, p.[Date] AS LastPoDate,
             p.Price, p.TaxType,
             (SELECT COUNT(DISTINCT x.VchCode) FROM po x WHERE x.PartyCode = p.PartyCode) AS Pos
      FROM po p JOIN dbo.Master1 m ON m.Code = p.PartyCode
      WHERE p.rn = 1`)).recordset;

  // Delivered in the last 30 days (Busy GRNs) — who is actually supplying.
  const recent = (await erpPool.request()
    .input('item', erpSql.Int, item.Code).input('vchType', erpSql.Int, GRN_VCHTYPE)
    .query(`
      SELECT t1.MasterCode1 AS PartyCode, SUM(t2.Value1) AS Qty, COUNT(DISTINCT t1.VchCode) AS Grns, MAX(t1.[Date]) AS LastGrn
      FROM dbo.Tran1 t1 JOIN dbo.Tran2 t2 ON t2.VchCode = t1.VchCode AND t2.RecType = 2 AND t2.MasterCode1 = @item
      WHERE t1.VchType = @vchType AND t1.[Date] >= DATEADD(day, -30, CAST(GETDATE() AS date))
      GROUP BY t1.MasterCode1`)).recordset;
  const recentBy = new Map(recent.map((r) => [r.PartyCode, r]));

  const orders = await loadBusyOrders(erpPool, item.Code);
  const openBy = new Map();
  for (const o of orders.filter((x) => x.open)) {
    const e = openBy.get(o.partyCode) || { balance: 0, pos: [] };
    e.balance = round3(e.balance + o.balance);
    e.pos.push(o.ordno);
    openBy.set(o.partyCode, e);
  }
  const ours = await suppliersByBusyCode(pool, rows.map((r) => r.PartyCode));

  return rows.map((r) => {
    const s = ours.get(r.PartyCode);
    const open = openBy.get(r.PartyCode);
    const rec = recentBy.get(r.PartyCode);
    return {
      supplierId: s?.SupplierId || null,
      supplierName: s?.SupplierName || r.Party,
      supplierActive: s ? !!s.IsActive : false,
      phone: s?.Phone || null,
      partyCode: r.PartyCode,
      party: r.Party,
      standingPrice: Number(r.Price) || 0,
      taxType: r.TaxType,
      lastPoNo: r.LastPoNo,
      lastPoDate: r.LastPoDate,
      posThisYear: r.Pos,
      openBalance: open?.balance || 0,
      openPos: open?.pos || [],
      delivered30d: rec ? round3(rec.Qty) : 0,
      grns30d: rec?.Grns || 0,
      lastGrn: rec?.LastGrn || null,
    };
  }).sort((a, b) => (b.delivered30d - a.delivered30d) || (b.posThisYear - a.posThisYear));
}

/** Standing price for one supplier (last PO for the item), or null if it has none. */
async function standingPriceFor(erpPool, itemCode, partyCode) {
  const r = (await erpPool.request()
    .input('item', erpSql.Int, itemCode).input('party', erpSql.Int, partyCode)
    .input('months', erpSql.Int, STANDING_MONTHS).input('vchType', erpSql.Int, PO_VCHTYPE)
    .query(`
      SELECT TOP 1 t2.D2 AS Price, LTRIM(RTRIM(st.Name)) AS TaxType, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date]
      FROM dbo.Tran1 t1
      JOIN dbo.Tran2 t2 ON t2.VchCode = t1.VchCode AND t2.RecType IN (4, 15) AND t2.MasterCode1 = @item
      LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1
      WHERE t1.VchType = @vchType AND t1.MasterCode1 = @party AND t2.D2 > 0
        AND t1.[Date] >= DATEADD(month, -@months, GETDATE())
      ORDER BY t1.[Date] DESC, t1.VchCode DESC`)).recordset[0];
  return r ? { price: Number(r.Price), taxType: r.TaxType, vchNo: r.VchNo, date: r.Date } : null;
}

/**
 * Busy POs for this requisition: the ones this system linked (LPOReconciliation)
 * and the ones Busy users keyed by hand with the requisition number in the
 * narration (the usual practice before 2026-11-24) that aren't linked yet.
 */
async function posForRequisition(pool, erpPool, reqn, items) {
  const linked = (await pool.request().input('id', sql.Int, reqn.RequisitionId).query(`
    SELECT rec.LPOReconciliationId, LTRIM(RTRIM(rec.BusyPurOrdNo)) AS BusyPurOrdNo, rec.BusySupplier, rec.SupplierId,
           rec.BusyDate, rec.TotalActualAmt, rec.ReconciledAt, u.FullName AS ByName
    FROM dbo.LPOReconciliation rec LEFT JOIN dbo.Users u ON u.UserId = rec.ReconciledByUserId
    WHERE rec.RequisitionId = @id ORDER BY rec.LPOReconciliationId`)).recordset;
  const reqNo = String(reqn.BusyOrdNo || '').trim().toUpperCase();
  // Busy PO lines per item: a combined PO (sawdust + offcuts) shows under both.
  const perItem = await Promise.all(items.map(async (it) => ({ it, orders: await loadBusyOrders(erpPool, it.Code) })));
  const allOrders = perItem.flatMap((p) => p.orders.map((o) => ({ ...o, itemName: p.it.Name })));
  const allLinked = await linkedOrdnos(pool, allOrders.map((o) => o.ordno));
  const mentionsReq = (o) => reqNo && (o.narration.toUpperCase().match(REQ_NO_RE) || [])[0] === reqNo;
  const handRaisedLines = allOrders.filter((o) => mentionsReq(o) && !allLinked.has(o.ordno));
  const linkedNos = new Set(linked.map((l) => l.BusyPurOrdNo));
  const linkedLines = allOrders.filter((o) => linkedNos.has(o.ordno));
  // one entry per hand-raised PO, with its lines for our items
  const handRaised = [];
  for (const o of handRaisedLines) {
    let po = handRaised.find((h) => h.ordno === o.ordno);
    if (!po) { po = { ordno: o.ordno, vchCode: o.vchCode, date: o.date, partyCode: o.partyCode, party: o.party, approvalLabel: o.approvalLabel, lines: [] }; handRaised.push(po); }
    po.lines.push({ itemName: o.itemName, ordered: o.ordered, received: o.received, balance: o.balance, price: o.price });
  }
  return {
    linked: linked.map((l) => ({ ...l, lines: linkedLines.filter((o) => o.ordno === l.BusyPurOrdNo).map((o) => ({ itemName: o.itemName, ordered: o.ordered, received: o.received, balance: o.balance, price: o.price })) })),
    handRaised,
    orderedByItem: (name) => round3(
      linkedLines.filter((o) => key(o.itemName) === key(name)).reduce((s, o) => s + o.ordered, 0)
      + handRaisedLines.filter((o) => key(o.itemName) === key(name)).reduce((s, o) => s + o.ordered, 0)),
  };
}

/** Set of ordnos already in LPOReconciliation. */
async function linkedOrdnos(pool, ordnos) {
  const set = new Set();
  const list = [...new Set(ordnos.filter(Boolean))];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const req = pool.request();
    chunk.forEach((o, j) => req.input(`o${j}`, sql.VarChar(50), o));
    const rows = (await req.query(`SELECT LTRIM(RTRIM(BusyPurOrdNo)) AS No FROM dbo.LPOReconciliation
      WHERE LTRIM(RTRIM(BusyPurOrdNo)) IN (${chunk.map((_, j) => `@o${j}`).join(',')})`)).recordset;
    rows.forEach((r) => set.add(r.No));
  }
  return set;
}

/**
 * Open orders for the item (Busy POs with a balance still to come), with the
 * supplier, the requisition each belongs to and how it was raised.
 */
async function openOrders(pool, erpPool, item, { includeClosed = false, includeStale = false, days = ORDERS_DAYS } = {}) {
  const orders = await loadBusyOrders(erpPool, item.Code, { days });
  const list = includeClosed ? orders : orders.filter((o) => o.open || (includeStale && o.stale));
  const ours = await suppliersByBusyCode(pool, list.map((o) => o.partyCode));
  const links = new Map();
  if (list.length) {
    const req = pool.request();
    list.forEach((o, i) => req.input(`o${i}`, sql.VarChar(50), o.ordno));
    const rows = (await req.query(`
      SELECT LTRIM(RTRIM(rec.BusyPurOrdNo)) AS No, r.RequisitionId, r.BusyOrdNo
      FROM dbo.LPOReconciliation rec LEFT JOIN dbo.Requisitions r ON r.RequisitionId = rec.RequisitionId
      WHERE LTRIM(RTRIM(rec.BusyPurOrdNo)) IN (${list.map((_, i) => `@o${i}`).join(',')})`)).recordset;
    rows.forEach((r) => links.set(r.No, r));
  }
  return list.map((o) => {
    const s = ours.get(o.partyCode);
    const link = links.get(o.ordno);
    return {
      ...o,
      supplierId: s?.SupplierId || null,
      supplierName: s?.SupplierName || o.party,
      requisitionId: link?.RequisitionId || null,
      requisitionNo: link?.BusyOrdNo || (o.narration.match(REQ_NO_RE) || [])[0] || null,
      raisedHere: o.narration.startsWith('[MTS '),
      linked: !!link,
    };
  });
}

/**
 * SQL condition "this requisition line may go on an RFQ": not a direct-supply
 * item and not already ordered directly. Adds its parameters to `request`.
 */
async function rfqEligibleLineSql(request, alias = 'ri') {
  const items = (await getDirectSupplyItems()).map((n) => n.toUpperCase());
  items.forEach((n, i) => request.input(`dsx${i}`, sql.NVarChar(100), n));
  const list = items.length ? items.map((_, i) => `@dsx${i}`).join(',') : 'NULL';
  return `(${alias}.DirectOrderedAt IS NULL AND ISNULL(UPPER(LTRIM(RTRIM(COALESCE(${alias}.ItemCode, ${alias}.ItemName)))), '') NOT IN (${list}))`;
}

// ── Delivery plan ────────────────────────────────────────────────────────

const isoDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

/** Plan rows for [from, to] (inclusive, yyyy-mm-dd) for one item. */
async function loadPlan(pool, itemName, from, to) {
  const rows = (await pool.request()
    .input('item', sql.NVarChar(100), itemName).input('from', sql.Date, from).input('to', sql.Date, to)
    .query(`
      SELECT p.PlanId, p.PlanDate, p.SupplierId, s.SupplierName, s.SupplierCode, s.Phone, p.BusyPurOrdNo,
             p.PlannedQty, p.Trucks, p.Notes, p.CreatedAt, cu.FullName AS CreatedByName,
             p.UpdatedAt, uu.FullName AS UpdatedByName
      FROM dbo.DirectSupplyPlan p
      JOIN dbo.Suppliers s ON s.SupplierId = p.SupplierId
      LEFT JOIN dbo.Users cu ON cu.UserId = p.CreatedByUserId
      LEFT JOIN dbo.Users uu ON uu.UserId = p.UpdatedByUserId
      WHERE p.ItemName = @item AND p.PlanDate BETWEEN @from AND @to
      ORDER BY p.PlanDate, s.SupplierName`)).recordset;
  return rows.map((r) => ({ ...r, PlanDate: isoDay(r.PlanDate), PlannedQty: r.PlannedQty != null ? Number(r.PlannedQty) : null }));
}

/**
 * What actually came, per day and supplier, for [from, to]:
 *   gate  trucks booked in at the gate (DeliveryEntries with the item) and
 *         their weighbridge net weight in kg
 *   grn   tonnes received in Busy (GRN item lines, VchType 4 RecType 2)
 * Keyed "yyyy-mm-dd|SupplierId".
 */
async function loadActuals(pool, erpPool, item, from, to) {
  const out = new Map();
  const slot = (day, supplierId) => {
    const k = `${day}|${supplierId}`;
    if (!out.has(k)) out.set(k, { day, supplierId, gateTrucks: 0, gateNetKg: 0, grnQty: 0, grns: 0 });
    return out.get(k);
  };

  const gate = (await pool.request()
    .input('code', sql.Int, item.Code).input('from', sql.Date, from).input('to', sql.Date, to)
    .query(`
      SELECT CONVERT(date, e.DeliveryDate) AS Day, e.SupplierId, COUNT(DISTINCT e.EntryId) AS Trucks,
             SUM(ISNULL(COALESCE(wb.NetKg, e.NetWeight), 0)) AS NetKg
      FROM dbo.DeliveryEntries e
      OUTER APPLY (SELECT TOP 1 COALESCE(w.FinalNetWeight, w.NetWeight) AS NetKg
                   FROM dbo.WeighbridgeRecords w WHERE w.EntryId = e.EntryId
                   ORDER BY w.WeighbridgeId DESC) wb
      WHERE CONVERT(date, e.DeliveryDate) BETWEEN @from AND @to AND e.SupplierId IS NOT NULL
        AND ISNULL(e.Status, '') NOT IN ('Cancelled', 'Rejected')
        AND EXISTS (SELECT 1 FROM dbo.DeliveryEntryItems ei WHERE ei.EntryId = e.EntryId AND ei.BusyItemCode = @code)
      GROUP BY CONVERT(date, e.DeliveryDate), e.SupplierId`)).recordset;
  for (const g of gate) {
    const s = slot(isoDay(g.Day), g.SupplierId);
    s.gateTrucks += g.Trucks;
    s.gateNetKg += Number(g.NetKg) || 0;
  }

  const grn = (await erpPool.request()
    .input('item', erpSql.Int, item.Code).input('vchType', erpSql.Int, GRN_VCHTYPE)
    .input('from', erpSql.Date, from).input('to', erpSql.Date, to)
    .query(`
      SELECT CONVERT(date, t1.[Date]) AS Day, t1.MasterCode1 AS PartyCode, SUM(t2.Value1) AS Qty, COUNT(DISTINCT t1.VchCode) AS Grns
      FROM dbo.Tran1 t1 JOIN dbo.Tran2 t2 ON t2.VchCode = t1.VchCode AND t2.RecType = 2 AND t2.MasterCode1 = @item
      WHERE t1.VchType = @vchType AND t1.[Date] BETWEEN @from AND @to
      GROUP BY CONVERT(date, t1.[Date]), t1.MasterCode1`)).recordset;
  const ours = await suppliersByBusyCode(pool, grn.map((g) => g.PartyCode));
  const unmatched = [];
  for (const g of grn) {
    const sup = ours.get(g.PartyCode);
    if (!sup) { unmatched.push(g); continue; }
    const s = slot(isoDay(g.Day), sup.SupplierId);
    s.grnQty = round3(s.grnQty + (Number(g.Qty) || 0));
    s.grns += g.Grns;
  }
  return { byKey: out, unmatchedGrns: unmatched };
}

/** Insert or update one plan cell (tonnes / trucks / PO / note are all optional); remove = delete it. */
async function savePlanCell(pool, { planDate, itemName, supplierId, plannedQty, trucks, notes, busyPurOrdNo, userId, remove = false }) {
  if (remove) {
    const del = await pool.request()
      .input('d', sql.Date, planDate).input('item', sql.NVarChar(100), itemName).input('s', sql.Int, supplierId)
      .query(`DELETE FROM dbo.DirectSupplyPlan OUTPUT DELETED.* WHERE PlanDate = @d AND ItemName = @item AND SupplierId = @s`);
    return { deleted: del.recordset[0] || null };
  }
  const r = await pool.request()
    .input('d', sql.Date, planDate)
    .input('item', sql.NVarChar(100), itemName)
    .input('s', sql.Int, supplierId)
    .input('qty', sql.Decimal(12, 3), plannedQty)
    .input('trucks', sql.Int, trucks)
    .input('notes', sql.NVarChar(300), notes || null)
    .input('po', sql.VarChar(50), busyPurOrdNo || null)
    .input('u', sql.Int, userId)
    .query(`
      MERGE dbo.DirectSupplyPlan WITH (HOLDLOCK) AS t
      USING (SELECT @d AS PlanDate, @item AS ItemName, @s AS SupplierId) AS x
        ON t.PlanDate = x.PlanDate AND t.ItemName = x.ItemName AND t.SupplierId = x.SupplierId
      WHEN MATCHED THEN UPDATE SET PlannedQty = @qty, Trucks = @trucks, Notes = @notes, BusyPurOrdNo = @po,
                                   UpdatedByUserId = @u, UpdatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (PlanDate, ItemName, SupplierId, PlannedQty, Trucks, Notes, BusyPurOrdNo, CreatedByUserId)
                            VALUES (@d, @item, @s, @qty, @trucks, @notes, @po, @u)
      OUTPUT $action AS Action, INSERTED.*;`);
  return { saved: r.recordset[0] };
}

module.exports = {
  OPEN_TOLERANCE,
  directItemFor, resolveItem, toBusyUnit, loadDirectRequisition, closeDirectLines, standingSuppliers, standingPriceFor,
  posForRequisition, openOrders, loadBusyOrders, loadPlan, loadActuals, savePlanCell, isoDay, rfqEligibleLineSql,
  getDirectSupplyItems, getPool, getErpPool,
};
