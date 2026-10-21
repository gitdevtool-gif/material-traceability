/**
 * Busy Receiving Service (2026-10-17)
 *
 * Read-only view of Busy's purchase chain, so this system can follow a
 * delivery from the gate to payment without anything being keyed twice:
 *
 *   Purchase Order (VchType 13) ──► GRN "Mat. Rcvd. from Party" (VchType 4,
 *   series 04GRN) ──► Purchase bill (VchType 2) ──► Payment (VchType 19)
 *
 * Busy links each step through Tran3 "pending references" (all verified
 * against BusyComp0006_db12026, see the 2026-10-17 change summary):
 *   RecType 4  pending ORDER   — PO line creates it (Method 1: MasterCode1
 *              item, MasterCode2 party, CM1 store, Value1 qty, Value3 price);
 *              a GRN or a purchase consumes it (Method 2, same RefCode).
 *   RecType 3  pending CHALLAN — a GRN creates it (Method 1); the purchase
 *              bill raised for that GRN consumes it (Method 2).
 *   RecType 1  pending BILL    — the purchase bill creates it (Method 1);
 *              payments / debit notes settle it (Method 2).
 * Quantities and amounts carry signs that differ by voucher, so every sum
 * here uses ABS(). RefCode is only unique within a RecType, so every join
 * on RefCode also matches RecType.
 *
 * Nothing here writes to Busy.
 */
const { sql } = require('../db');
const { sql: erpSql } = require('../erpDb');

const VCH = { PURCHASE: 2, GRN: 4, PO: 13, PAYMENT: 19 };
// Busy's GRN series ("04GRN"); type 4 also has a customer-returns series we ignore.
const GRN_SERIES_CODE = parseInt(process.env.BUSY_GRN_SERIES_CODE, 10) || 12076;

const round = (n, dp = 2) => Math.round((Number(n) || 0) * 10 ** dp) / 10 ** dp;
const inList = (req, prefix, values, type = erpSql.Int) => {
  values.forEach((v, i) => req.input(`${prefix}${i}`, type, v));
  return values.map((_, i) => `@${prefix}${i}`).join(',') || 'NULL';
};
const chunk = (arr, size = 500) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ── Purchase orders ─────────────────────────────────────────────────────────

/**
 * PO lines with quantity still pending (ordered − received by any GRN or
 * purchase). Filter by party, or by explicit RefCodes.
 */
async function getOpenPoLines(erpPool, { partyCode, refCodes, itemCodes, includeUnapproved = true } = {}) {
  const req = erpPool.request()
    .input('poType', erpSql.Int, VCH.PO);
  let where = '';
  if (partyCode) { where += ' AND t3.MasterCode2 = @party'; req.input('party', erpSql.Int, partyCode); }
  if (itemCodes) {
    const ids = [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    where += ` AND t3.MasterCode1 IN (${ids.join(',')})`;
  }
  if (refCodes) {
    if (refCodes.length === 0) return [];
    where += ` AND t3.RefCode IN (${inList(req, 'r', refCodes)})`;
  }
  const result = await req.query(`
    WITH po AS (
      SELECT t3.RefCode, t3.VchCode, t3.MasterCode1 AS ItemCode, t3.MasterCode2 AS PartyCode, t3.CM1 AS StoreCode,
             ABS(t3.Value1) AS Ordered, t3.Value3 AS Price, t3.DueDate, t3.ItemSrNo
      FROM dbo.Tran3 t3
      WHERE t3.VchType = @poType AND t3.Method = 1 AND t3.RecType = 4 ${where}
    ), rc AS (
      SELECT x.RefCode, SUM(ABS(x.Value1)) AS Received
      FROM dbo.Tran3 x
      WHERE x.RecType = 4 AND x.Method = 2 AND x.RefCode IN (SELECT RefCode FROM po)
      GROUP BY x.RefCode
    )
    SELECT po.RefCode, po.VchCode, po.ItemCode, po.PartyCode, po.StoreCode, po.Ordered, po.Price, po.DueDate, po.ItemSrNo,
           ISNULL(rc.Received, 0) AS Received, po.Ordered - ISNULL(rc.Received, 0) AS Pending,
           LTRIM(RTRIM(t1.VchNo)) AS PONo, t1.[Date] AS PODate, t1.ApprovalStatus,
           LTRIM(RTRIM(it.Name)) AS ItemName, LTRIM(RTRIM(u.Name)) AS UnitName, LTRIM(RTRIM(mc.Name)) AS Store,
           LTRIM(RTRIM(p.Name)) AS Party
    FROM po
    JOIN dbo.Tran1 t1 ON t1.VchCode = po.VchCode
    LEFT JOIN rc ON rc.RefCode = po.RefCode
    LEFT JOIN dbo.Master1 it ON it.Code = po.ItemCode
    LEFT JOIN dbo.Master1 u  ON u.Code = it.CM1
    LEFT JOIN dbo.Master1 mc ON mc.Code = po.StoreCode
    LEFT JOIN dbo.Master1 p  ON p.Code = po.PartyCode
    WHERE po.Ordered - ISNULL(rc.Received, 0) > 0.0001
      ${includeUnapproved ? '' : 'AND t1.ApprovalStatus = 1'}
    ORDER BY t1.[Date], po.VchCode, po.ItemSrNo
  `);
  return result.recordset.map((r) => ({
    refCode: r.RefCode,
    poVchCode: r.VchCode,
    poNo: r.PONo,
    poDate: r.PODate,
    approved: r.ApprovalStatus === 1,
    dueDate: r.DueDate,
    partyCode: r.PartyCode,
    party: r.Party,
    itemCode: r.ItemCode,
    itemName: r.ItemName,
    unitName: r.UnitName,
    store: r.Store,
    price: Number(r.Price) || 0,
    ordered: round(r.Ordered, 3),
    received: round(r.Received, 3),
    pending: round(r.Pending, 3),
  }));
}

/**
 * Every approved PO that isn't fully received, one row per PO.
 * state: 'Not received' | 'Partly received'.
 */
async function getPoTracker(erpPool, { partyCode } = {}) {
  const lines = await getOpenPoLines(erpPool, { partyCode, includeUnapproved: false });
  const byPo = new Map();
  for (const l of lines) {
    let po = byPo.get(l.poVchCode);
    if (!po) {
      po = {
        poVchCode: l.poVchCode, poNo: l.poNo, poDate: l.poDate, partyCode: l.partyCode, party: l.party,
        dueDate: l.dueDate, lines: [], pendingValue: 0, anyReceived: false,
      };
      byPo.set(l.poVchCode, po);
    }
    po.lines.push(l);
    po.pendingValue += l.pending * l.price;
    if (l.received > 0) po.anyReceived = true;
    if (l.dueDate && (!po.dueDate || l.dueDate > po.dueDate)) po.dueDate = l.dueDate;
  }
  const now = Date.now();
  return [...byPo.values()].map((po) => ({
    ...po,
    pendingValue: round(po.pendingValue),
    state: po.anyReceived ? 'Partly received' : 'Not received',
    ageDays: Math.floor((now - new Date(po.poDate).getTime()) / 864e5),
  }));
}

// ── GRNs ────────────────────────────────────────────────────────────────────

/** Busy GRN headers + item lines + the PO numbers each one received against. */
async function getGrns(erpPool, { vchCodes, grnNos, partyCode, since, until } = {}) {
  const req = erpPool.request()
    .input('grnType', erpSql.Int, VCH.GRN)
    .input('series', erpSql.Int, GRN_SERIES_CODE);
  let where = 't1.VchType = @grnType AND t1.VchSeriesCode = @series';
  if (vchCodes) {
    if (vchCodes.length === 0) return [];
    where += ` AND t1.VchCode IN (${inList(req, 'v', vchCodes)})`;
  }
  if (grnNos) {
    if (grnNos.length === 0) return [];
    where += ` AND LTRIM(RTRIM(t1.VchNo)) IN (${inList(req, 'n', grnNos.map((n) => String(n).trim()), erpSql.NVarChar(50))})`;
  }
  if (partyCode) { where += ' AND t1.MasterCode1 = @party'; req.input('party', erpSql.Int, partyCode); }
  if (since) { where += ' AND t1.[Date] >= @since'; req.input('since', erpSql.DateTime, since); }
  if (until) { where += ' AND t1.[Date] <= @until'; req.input('until', erpSql.DateTime, until); }

  const head = await req.query(`
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.MasterCode1 AS PartyCode,
           LTRIM(RTRIM(p.Name)) AS Party, t1.VchAmtBaseCur AS Amount, t1.ApprovalStatus,
           LTRIM(RTRIM(oi.Transport)) AS Vehicle, LTRIM(RTRIM(oi.Narration1)) AS Narration
    FROM dbo.Tran1 t1
    LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
    WHERE ${where}
    ORDER BY t1.[Date] DESC, t1.VchCode DESC
  `);
  const grns = head.recordset;
  if (grns.length === 0) return [];

  const linesByVch = {};
  const posByVch = {};
  for (const part of chunk(grns.map((g) => g.VchCode))) {
    const lr = erpPool.request();
    const ids = inList(lr, 'c', part);
    const [lines, pos] = await Promise.all([
      lr.query(`
        SELECT t2.VchCode, t2.SrNo, t2.MasterCode1 AS ItemCode, LTRIM(RTRIM(it.Name)) AS ItemName,
               ABS(t2.D1) AS Qty, t2.D2 AS Price, t2.D5 AS Amount, LTRIM(RTRIM(mc.Name)) AS Store, LTRIM(RTRIM(u.Name)) AS UnitName
        FROM dbo.Tran2 t2
        LEFT JOIN dbo.Master1 it ON it.Code = t2.MasterCode1
        LEFT JOIN dbo.Master1 mc ON mc.Code = t2.MasterCode2
        LEFT JOIN dbo.Master1 u  ON u.Code = it.CM1
        WHERE t2.RecType = 2 AND t2.VchCode IN (${ids})
        ORDER BY t2.VchCode, t2.SrNo`),
      (() => {
        const pr = erpPool.request();
        const ids2 = inList(pr, 'c', part);
        return pr.query(`
          SELECT DISTINCT VchCode, LTRIM(RTRIM(No)) AS PONo
          FROM dbo.Tran3 WHERE RecType = 4 AND Method = 2 AND VchCode IN (${ids2})`);
      })(),
    ]);
    for (const l of lines.recordset) (linesByVch[l.VchCode] ||= []).push(l);
    for (const p of pos.recordset) (posByVch[p.VchCode] ||= []).push(p.PONo);
  }

  return grns.map((g) => ({
    vchCode: g.VchCode,
    grnNo: g.VchNo,
    date: g.Date,
    partyCode: g.PartyCode,
    party: g.Party,
    amount: Number(g.Amount) || 0,
    approved: g.ApprovalStatus !== 2,
    vehicle: g.Vehicle && g.Vehicle !== '.' ? g.Vehicle : null,
    narration: g.Narration || null,
    poNos: posByVch[g.VchCode] || [],
    lines: (linesByVch[g.VchCode] || []).map((l) => ({
      srNo: l.SrNo, itemCode: l.ItemCode, itemName: l.ItemName, unitName: l.UnitName,
      qty: round(l.Qty, 3), price: Number(l.Price) || 0, amount: Number(l.Amount) || 0, store: l.Store,
    })),
  }));
}

/**
 * Billing + payment state for GRNs:
 *   billed: 'Not billed' | 'Partly billed' | 'Billed'
 *   paid:   null (no bill yet) | 'Unpaid' | 'Part paid' | 'Paid'
 * with the purchase bill(s) and supplier invoice numbers.
 */
async function getGrnLifecycle(erpPool, grnVchCodes) {
  const out = {};
  for (const id of grnVchCodes) out[id] = { billed: 'Not billed', paid: null, bills: [] };
  if (grnVchCodes.length === 0) return out;

  for (const part of chunk(grnVchCodes)) {
    const req = erpPool.request();
    const ids = inList(req, 'g', part);
    const challans = await req.query(`
      SELECT c.VchCode AS GrnVchCode, c.RefCode, ABS(c.Value1) AS Qty,
             (SELECT SUM(ABS(u.Value1)) FROM dbo.Tran3 u WHERE u.RefCode = c.RefCode AND u.RecType = 3 AND u.Method = 2) AS BilledQty
      FROM dbo.Tran3 c
      WHERE c.RecType = 3 AND c.Method = 1 AND c.VchCode IN (${ids})`);

    const qty = {};
    for (const c of challans.recordset) {
      const q = (qty[c.GrnVchCode] ||= { total: 0, billed: 0 });
      q.total += Number(c.Qty) || 0;
      q.billed += Number(c.BilledQty) || 0;
    }
    for (const [id, q] of Object.entries(qty)) {
      out[id].billed = q.billed <= 0.0001 ? 'Not billed' : q.billed + 0.0001 < q.total ? 'Partly billed' : 'Billed';
    }

    const req2 = erpPool.request();
    const ids2 = inList(req2, 'g', part);
    const bills = await req2.query(`
      SELECT DISTINCT c.VchCode AS GrnVchCode, u.VchCode AS PurchVchCode
      FROM dbo.Tran3 c
      JOIN dbo.Tran3 u ON u.RefCode = c.RefCode AND u.RecType = 3 AND u.Method = 2
      WHERE c.RecType = 3 AND c.Method = 1 AND c.VchCode IN (${ids2})`);
    const purchCodes = [...new Set(bills.recordset.map((b) => b.PurchVchCode))];
    const billInfo = await getBillPayments(erpPool, purchCodes);
    for (const b of bills.recordset) {
      const info = billInfo[b.PurchVchCode];
      if (info) out[b.GrnVchCode].bills.push(info);
    }
  }

  for (const v of Object.values(out)) {
    if (v.bills.length === 0) continue;
    const total = v.bills.reduce((s, b) => s + b.amount, 0);
    const paid = v.bills.reduce((s, b) => s + b.paid, 0);
    v.paid = paid <= 0.5 ? 'Unpaid' : paid + 0.5 < total ? 'Part paid' : 'Paid';
  }
  return out;
}

/** Purchase bills (VchType 2): amount, supplier invoice no, paid so far. Keyed by VchCode. */
async function getBillPayments(erpPool, purchVchCodes) {
  const out = {};
  for (const part of chunk(purchVchCodes)) {
    if (part.length === 0) continue;
    const req = erpPool.request();
    const ids = inList(req, 'p', part);
    const result = await req.query(`
      SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.VchAmtBaseCur AS VchAmount,
             LTRIM(RTRIM(oi.PurchaseBillNo)) AS SupplierInvoiceNo,
             b.DueDate, ABS(b.Value1) AS BillAmount,
             (SELECT SUM(ABS(s.Value1)) FROM dbo.Tran3 s WHERE s.RefCode = b.RefCode AND s.RecType = 1 AND s.Method = 2) AS Paid
      FROM dbo.Tran1 t1
      LEFT JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
      LEFT JOIN dbo.Tran3 b ON b.VchCode = t1.VchCode AND b.RecType = 1 AND b.Method = 1
      WHERE t1.VchCode IN (${ids})`);
    for (const r of result.recordset) {
      const amount = Number(r.BillAmount ?? r.VchAmount) || 0;
      const prev = out[r.VchCode];
      if (prev) { prev.amount += amount; prev.paid += Number(r.Paid) || 0; continue; }
      out[r.VchCode] = {
        vchCode: r.VchCode, billNo: r.VchNo, date: r.Date, dueDate: r.DueDate,
        // Busy stores eTIMS invoice numbers with a leading "|"
        supplierInvoiceNo: String(r.SupplierInvoiceNo || '').replace(/^\|+/, '').trim() || null,
        amount, paid: Number(r.Paid) || 0,
      };
    }
  }
  for (const b of Object.values(out)) {
    b.amount = round(b.amount);
    b.paid = round(b.paid);
    b.balance = round(b.amount - b.paid);
    b.state = b.paid <= 0.5 ? 'Unpaid' : b.balance > 0.5 ? 'Part paid' : 'Paid';
  }
  return out;
}

/**
 * GRNs received since `since` that have no purchase bill yet (or only part
 * of one) — what accounts still has to invoice.
 */
async function getUnbilledGrns(erpPool, { since }) {
  const grns = await getGrns(erpPool, { since });
  const life = await getGrnLifecycle(erpPool, grns.map((g) => g.vchCode));
  return grns
    .filter((g) => life[g.vchCode].billed !== 'Billed')
    .map((g) => ({ ...g, billed: life[g.vchCode].billed, bills: life[g.vchCode].bills }));
}

/**
 * Purchase bills since `since` that aren't fully paid, with the GRN(s) and
 * PO(s) behind each one — PO → GRN → bill side by side for payment approval.
 */
async function getUnpaidBills(erpPool, { since }) {
  const req = erpPool.request()
    .input('purchType', erpSql.Int, VCH.PURCHASE)
    .input('since', erpSql.DateTime, since);
  const codes = (await req.query(`
    SELECT t1.VchCode FROM dbo.Tran1 t1
    WHERE t1.VchType = @purchType AND t1.[Date] >= @since`)).recordset.map((r) => r.VchCode);

  const bills = Object.values(await getBillPayments(erpPool, codes)).filter((b) => b.state !== 'Paid');
  if (bills.length === 0) return [];

  // GRNs behind each bill (challans it consumed) and POs consumed directly.
  const grnByBill = {};
  const poByBill = {};
  for (const part of chunk(bills.map((b) => b.vchCode))) {
    const r1 = erpPool.request();
    const ids = inList(r1, 'b', part);
    const links = await r1.query(`
      SELECT DISTINCT u.VchCode AS PurchVchCode, c.VchCode AS GrnVchCode
      FROM dbo.Tran3 u
      JOIN dbo.Tran3 c ON c.RefCode = u.RefCode AND c.RecType = 3 AND c.Method = 1
      WHERE u.RecType = 3 AND u.Method = 2 AND u.VchCode IN (${ids})`);
    for (const l of links.recordset) (grnByBill[l.PurchVchCode] ||= []).push(l.GrnVchCode);

    const r2 = erpPool.request();
    const ids2 = inList(r2, 'b', part);
    const pos = await r2.query(`
      SELECT DISTINCT VchCode, LTRIM(RTRIM(No)) AS PONo FROM dbo.Tran3
      WHERE RecType = 4 AND Method = 2 AND VchCode IN (${ids2})`);
    for (const p of pos.recordset) (poByBill[p.VchCode] ||= []).push(p.PONo);
  }

  const grnCodes = [...new Set(Object.values(grnByBill).flat())];
  const grns = await getGrns(erpPool, { vchCodes: grnCodes });
  const grnMap = new Map(grns.map((g) => [g.vchCode, g]));

  const partyReq = erpPool.request();
  const partyRows = (await partyReq.query(`
    SELECT t1.VchCode, t1.MasterCode1 AS PartyCode, LTRIM(RTRIM(p.Name)) AS Party
    FROM dbo.Tran1 t1 LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
    WHERE t1.VchCode IN (${inList(partyReq, 'q', bills.map((b) => b.vchCode))})`)).recordset;
  const partyMap = new Map(partyRows.map((r) => [r.VchCode, r]));

  return bills.map((b) => {
    const billGrns = (grnByBill[b.vchCode] || []).map((id) => grnMap.get(id)).filter(Boolean);
    const poNos = [...new Set([...(poByBill[b.vchCode] || []), ...billGrns.flatMap((g) => g.poNos)])];
    const grnAmount = round(billGrns.reduce((s, g) => s + g.amount, 0));
    return {
      ...b,
      partyCode: partyMap.get(b.vchCode)?.PartyCode,
      party: partyMap.get(b.vchCode)?.Party,
      grns: billGrns.map((g) => ({ vchCode: g.vchCode, grnNo: g.grnNo, date: g.date, amount: g.amount })),
      grnAmount,
      poNos,
      // Bill vs goods received: only meaningful when the bill was raised on GRNs.
      billVsGrnDiff: billGrns.length ? round(b.amount - grnAmount) : null,
    };
  });
}

// ── Busy masters ────────────────────────────────────────────────────────────

/** Busy items for the gate's "no PO" picker. */
async function searchBusyItems(erpPool, search, limit = 30) {
  const result = await erpPool.request()
    .input('q', erpSql.NVarChar(60), `%${String(search || '').trim()}%`)
    .query(`
      SELECT TOP (${Math.min(100, Math.max(1, limit))}) it.Code, LTRIM(RTRIM(it.Name)) AS Name,
             LTRIM(RTRIM(it.Alias)) AS Alias, LTRIM(RTRIM(u.Name)) AS UnitName
      FROM dbo.Master1 it LEFT JOIN dbo.Master1 u ON u.Code = it.CM1
      WHERE it.MasterType = 6 AND (it.Name LIKE @q OR it.Alias LIKE @q)
      ORDER BY it.Name`);
  return result.recordset.map((r) => ({ itemCode: r.Code, itemName: r.Name, alias: r.Alias || null, unitName: r.UnitName }));
}

async function getBusyItems(erpPool, itemCodes) {
  if (!itemCodes.length) return new Map();
  const req = erpPool.request();
  const result = await req.query(`
    SELECT it.Code, LTRIM(RTRIM(it.Name)) AS Name, LTRIM(RTRIM(u.Name)) AS UnitName
    FROM dbo.Master1 it LEFT JOIN dbo.Master1 u ON u.Code = it.CM1
    WHERE it.MasterType = 6 AND it.Code IN (${inList(req, 'i', itemCodes)})`);
  return new Map(result.recordset.map((r) => [r.Code, { itemCode: r.Code, itemName: r.Name, unitName: r.UnitName }]));
}

/**
 * The Materials row for a Busy item — created on first use, or an existing
 * same-named material adopted — so every gate/GRN line points at a real
 * Busy item. `request` is a factory returning a fresh sql.Request (pool or
 * transaction).
 */
async function ensureMaterialForBusyItem(request, { itemCode, itemName, unitName }) {
  const existing = await request()
    .input('code', sql.Int, itemCode)
    .query('SELECT MaterialId, UOM FROM dbo.Materials WHERE BusyItemCode = @code');
  if (existing.recordset[0]) return existing.recordset[0];

  const byName = await request()
    .input('name', sql.NVarChar(200), itemName)
    .query(`SELECT TOP 1 MaterialId, UOM FROM dbo.Materials
            WHERE BusyItemCode IS NULL AND UPPER(LTRIM(RTRIM(MaterialName))) = UPPER(LTRIM(RTRIM(@name)))
            ORDER BY MaterialId`);
  if (byName.recordset[0]) {
    await request()
      .input('id', sql.Int, byName.recordset[0].MaterialId)
      .input('code', sql.Int, itemCode)
      .input('uom', sql.VarChar(20), String(unitName || byName.recordset[0].UOM || 'Units').slice(0, 20))
      .query('UPDATE dbo.Materials SET BusyItemCode = @code, UOM = @uom, UpdatedAt = GETUTCDATE() WHERE MaterialId = @id');
    return { MaterialId: byName.recordset[0].MaterialId, UOM: unitName || byName.recordset[0].UOM };
  }

  const created = await request()
    .input('mcode', sql.VarChar(30), `BUSY-${itemCode}`)
    .input('name', sql.NVarChar(200), itemName)
    .input('uom', sql.VarChar(20), String(unitName || 'Units').slice(0, 20))
    .input('code', sql.Int, itemCode)
    .query(`INSERT INTO dbo.Materials (MaterialCode, MaterialName, UOM, BusyItemCode)
            OUTPUT INSERTED.MaterialId, INSERTED.UOM
            VALUES (@mcode, @name, @uom, @code)`);
  return created.recordset[0];
}

module.exports = {
  VCH,
  GRN_SERIES_CODE,
  getOpenPoLines,
  getPoTracker,
  getGrns,
  getGrnLifecycle,
  getBillPayments,
  getUnbilledGrns,
  getUnpaidBills,
  searchBusyItems,
  getBusyItems,
  ensureMaterialForBusyItem,
};
