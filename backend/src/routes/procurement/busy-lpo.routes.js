/**
 * Busy LPO Routes (2026-10-15)
 *
 * Lets Procurement mark an awarded supplier as "LPO raised in Busy" by
 * pointing at the actual Busy Purchase Order, and lists every LPO raised
 * that way with its live Busy status.
 *
 * Raising the PO from here (2026-10-17): POST /push saves the PO through
 * Busy's own COM API (services/busy-bridge.service.js), so Busy allocates
 * the number itself. Everything else in this file stays read-only.
 *
 * We still never write Busy's tables directly: a Busy Purchase Order (VchType 13) spans Tran1 (header), Tran2
 * (item + VAT bill-sundry lines), Tran3 (pending-order references Busy
 * uses to link later purchases/GRNs), ItemDesc and VchOtherInfo, and its
 * keys (Tran1.VchCode, Tran3.RefCode, Tran1.AutoVchNo series counter) are
 * allocated by the Busy desktop app itself — there is no IDENTITY column
 * or sequence. Inserting from outside would race Busy users for the same
 * numbers and skip Busy's own tax/pending-order calculations. See the
 * reverse-engineering notes in the 2026-10-15 change summary.
 *
 * Marking raised reuses createReconciliation(), so it is the same record
 * the LPO Reconciliation page and the auto-matcher create: the award
 * leaves the Awarded Suppliers queue and the requisitions move to
 * 'Reconciled' exactly as before. The ordno is verified against Busy
 * before anything is written — the amounts stored come from Busy, never
 * from the browser.
 *
 * Busy facts used here (verified against Pur-2194---2026-27):
 *   Tran1.VchType = 13           Purchase Order
 *   Tran1.MasterCode1            supplier = Master1.Code = our Suppliers.SupplierCode
 *   Tran1.VchAmtBaseCur          grand total incl. VAT
 *   Tran1.ApprovalStatus         1 = Approved, 2 = Pending approval
 *   Tran2.RecType = 4            item line: ABS(D1) qty, D2 price, D5 amount excl. VAT
 *   Tran2.RecType = 15           same item line while the PO is pending approval
 *                                (Busy rewrites 15 -> 4 and 10 -> 3 on approval)
 *   Tran12                       one row per print (Date, UserName)
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { getErpPool, sql: erpSql } = require('../../erpDb');
const { authenticate, authorize } = require('../../middleware/auth');
const { createReconciliation } = require('../../services/lpo-reconciliation.service');
const { writeAuditLog } = require('../../services/audit.service');
const config = require('../../config');
const logger = require('../../logger');
const busyBridge = require('../../services/busy-bridge.service');
const { PO_VCHTYPE, buildPurchaseOrder, buildFuelPurchaseOrder, listFuelSuppliers, findExistingPushedPo, listBusyStores, markPendingApproval, resolveBusyUser, attributeToBusyUser } = require('../../services/busy-po.service');

const router = express.Router();

const VIEW_ROLES = ['Admin', 'Procurement', 'Director'];
const MARK_ROLES = ['Admin', 'Procurement'];
const BUSY_PO_VCHTYPE = 13;

const APPROVAL_LABELS = { 1: 'Approved', 2: 'Pending approval' };

/**
 * Load Busy POs (header + item lines) matching one filter. Exactly one of
 * vchNos / autoVchNo / supplierCode should be given.
 */
async function fetchBusyLpos(erpPool, { vchNos, autoVchNo, supplierCode, supplierName, since, limit = 50 }) {
  const req = erpPool.request().input('vchType', erpSql.Int, BUSY_PO_VCHTYPE);
  let where = 't1.VchType = @vchType';

  if (vchNos) {
    if (vchNos.length === 0) return [];
    where += ` AND LTRIM(RTRIM(t1.VchNo)) IN (${vchNos.map((_, i) => `@v${i}`).join(',')})`;
    vchNos.forEach((v, i) => req.input(`v${i}`, erpSql.NVarChar(50), String(v).trim()));
  } else if (autoVchNo) {
    where += ' AND t1.AutoVchNo = @autoVchNo';
    req.input('autoVchNo', erpSql.Int, autoVchNo);
  } else if (supplierCode) {
    where += ' AND t1.MasterCode1 = @supplierCode';
    req.input('supplierCode', erpSql.Int, supplierCode);
  } else if (supplierName) {
    where += ' AND LTRIM(RTRIM(sup.Name)) LIKE @supplierName';
    req.input('supplierName', erpSql.NVarChar(210), `%${String(supplierName).trim()}%`);
  } else {
    return [];
  }
  if (since) {
    where += ' AND t1.[Date] >= @since';
    req.input('since', erpSql.DateTime, since);
  }

  const headers = await req.query(`
    SELECT TOP (${Math.max(1, Math.min(500, parseInt(limit, 10) || 50))})
      t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.MasterCode1 AS SupplierCode,
      LTRIM(RTRIM(sup.Name)) AS Supplier, t1.VchAmtBaseCur AS GrandTotal,
      t1.ApprovalStatus, t1.DocPrinted,
      prints.PrintCount, prints.LastPrintedAt, prints.LastPrintedBy
    FROM dbo.Tran1 t1
    LEFT JOIN dbo.Master1 sup ON sup.Code = t1.MasterCode1
    OUTER APPLY (
      SELECT COUNT(*) AS PrintCount, MAX(p.[Date]) AS LastPrintedAt,
             (SELECT TOP 1 LTRIM(RTRIM(p2.UserName)) FROM dbo.Tran12 p2
               WHERE p2.VchCode = t1.VchCode ORDER BY p2.[Date] DESC) AS LastPrintedBy
      FROM dbo.Tran12 p WHERE p.VchCode = t1.VchCode
    ) prints
    WHERE ${where}
    ORDER BY t1.[Date] DESC, t1.VchCode DESC
  `);
  const rows = headers.recordset;
  if (rows.length === 0) return [];

  const linesReq = erpPool.request();
  rows.forEach((r, i) => linesReq.input(`c${i}`, erpSql.Int, r.VchCode));
  const lines = await linesReq.query(`
    SELECT t2.VchCode, t2.SrNo, LTRIM(RTRIM(it.Name)) AS itemName,
           ABS(t2.D1) AS Qty, t2.D2 AS Price, t2.D5 AS Amt,
           LTRIM(RTRIM(mc.Name)) AS MatCenter
    FROM dbo.Tran2 t2
    LEFT JOIN dbo.Master1 it ON it.Code = t2.MasterCode1
    LEFT JOIN dbo.Master1 mc ON mc.Code = t2.MasterCode2
    WHERE t2.RecType IN (4, 15) AND t2.VchCode IN (${rows.map((_, i) => `@c${i}`).join(',')})
    ORDER BY t2.VchCode, t2.SrNo
  `);
  const linesByVch = {};
  for (const l of lines.recordset) (linesByVch[l.VchCode] ||= []).push(l);

  return rows.map((r) => {
    const items = linesByVch[r.VchCode] || [];
    return {
      vchCode: r.VchCode,
      ordno: r.VchNo,
      date: r.Date,
      supplierCode: r.SupplierCode,
      supplier: r.Supplier,
      matCenter: [...new Set(items.map((i) => i.MatCenter).filter(Boolean))].join(', '),
      totalAmt: items.reduce((s, i) => s + (Number(i.Amt) || 0), 0), // excl. VAT, same basis as PurOrder.Amt
      grandTotal: Number(r.GrandTotal) || 0,                          // incl. VAT
      approvalStatus: r.ApprovalStatus,
      approvalLabel: APPROVAL_LABELS[r.ApprovalStatus] || `Status ${r.ApprovalStatus}`,
      printCount: r.PrintCount || 0,
      lastPrintedAt: r.LastPrintedAt,
      lastPrintedBy: r.LastPrintedBy,
      items,
    };
  });
}

/** Map of BusyPurOrdNo -> { RFQNumber } for ordnos already linked in our system. */
async function getLinkedOrdnos(pool, ordnos) {
  if (!ordnos || ordnos.length === 0) return {};
  const req = pool.request();
  ordnos.forEach((o, i) => req.input(`o${i}`, sql.VarChar(50), String(o).trim()));
  const result = await req.query(`
    SELECT rec.BusyPurOrdNo, rfq.RFQNumber
    FROM dbo.LPOReconciliation rec
    LEFT JOIN dbo.Requisitions legacyReq ON legacyReq.RequisitionId = rec.RequisitionId
    LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = COALESCE(rec.RFQId, legacyReq.RFQId)
    WHERE rec.BusyPurOrdNo IN (${ordnos.map((_, i) => `@o${i}`).join(',')})
  `);
  const map = {};
  for (const r of result.recordset) map[String(r.BusyPurOrdNo).trim()] = { rfqNumber: r.RFQNumber };
  return map;
}

async function getSupplier(pool, supplierId) {
  const result = await pool.request()
    .input('supplierId', sql.Int, supplierId)
    .query('SELECT SupplierId, SupplierName, SupplierCode FROM dbo.Suppliers WHERE SupplierId = @supplierId');
  return result.recordset[0] || null;
}

const busyCodeOf = (supplier) => {
  const code = parseInt(String(supplier?.SupplierCode || '').trim(), 10);
  return Number.isFinite(code) && code > 0 ? code : null;
};

// ── GET /api/procurement/busy-lpo/lookup?ordno= ──────────────────────────────
// Accepts the full Busy number ("Pur-2194---2026-27") or just the running
// number ("2194"). Returns every match (normally one) with its items, and
// whether it's already linked to an RFQ in our system.
router.get('/lookup', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const raw = String(req.query.ordno || '').trim();
    if (!raw) return res.status(400).json({ error: 'ordno is required' });

    const erpPool = await getErpPool();
    const lpos = /^\d+$/.test(raw)
      ? await fetchBusyLpos(erpPool, { autoVchNo: parseInt(raw, 10), limit: 10 })
      : await fetchBusyLpos(erpPool, { vchNos: [raw], limit: 10 });

    const linked = await getLinkedOrdnos(await getPool(), lpos.map((l) => l.ordno));
    res.json(lpos.map((l) => ({ ...l, linkedTo: linked[l.ordno] || null })));
  } catch (err) { next(err); }
});

// ── GET /api/procurement/busy-lpo/candidates?supplierId=&since= ──────────────
// Busy POs for this supplier, not yet linked to anything in our system —
// the likely LPO(s) Procurement just raised for an award. Matched on the
// Busy party code (exact) when the supplier has one, else on name.
router.get('/candidates', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const supplierId = parseInt(req.query.supplierId, 10);
    if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });

    const pool = await getPool();
    const supplier = await getSupplier(pool, supplierId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    let since = req.query.since ? new Date(req.query.since) : null;
    if (since && Number.isNaN(since.getTime())) since = null;
    if (since) since.setDate(since.getDate() - 3); // allow an LPO raised just before the in-app approval

    const erpPool = await getErpPool();
    const code = busyCodeOf(supplier);
    const lpos = code
      ? await fetchBusyLpos(erpPool, { supplierCode: code, since, limit: 30 })
      : await fetchBusyLpos(erpPool, { supplierName: supplier.SupplierName, since, limit: 30 });

    const linked = await getLinkedOrdnos(pool, lpos.map((l) => l.ordno));
    res.json({
      matchedBy: code ? 'busyCode' : 'name',
      lpos: lpos.filter((l) => !linked[l.ordno]),
    });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/busy-lpo/mark-raised ───────────────────────────────
// Body: { busyOrdNo, rfqId, quoteEvaluationId, supplierId, awardType,
//         notes?, confirmSupplierMismatch? }
router.post('/mark-raised', authenticate, authorize(...MARK_ROLES), async (req, res, next) => {
  try {
    const { busyOrdNo, rfqId, quoteEvaluationId, supplierId, awardType, notes, confirmSupplierMismatch } = req.body;
    const parsedRfqId = parseInt(rfqId, 10);
    const parsedSupplierId = parseInt(supplierId, 10);
    const ordno = String(busyOrdNo || '').trim();
    if (!ordno || !parsedRfqId || !parsedSupplierId) {
      return res.status(400).json({ error: 'busyOrdNo, rfqId and supplierId are required' });
    }
    const isSplit = awardType === 'split';

    const pool = await getPool();

    // Award still pending? (guards double-clicks and a second user marking it)
    const already = await pool.request()
      .input('rfqId', sql.Int, parsedRfqId)
      .input('supplierId', sql.Int, parsedSupplierId)
      .input('isSplit', sql.Bit, isSplit ? 1 : 0)
      .query(`
        SELECT TOP 1 BusyPurOrdNo FROM dbo.LPOReconciliation
        WHERE RFQId = @rfqId AND (@isSplit = 0 OR SupplierId = @supplierId)
      `);
    if (already.recordset.length > 0) {
      return res.status(409).json({
        error: `This award is already linked to Busy LPO ${String(already.recordset[0].BusyPurOrdNo).trim()}`,
      });
    }

    const supplier = await getSupplier(pool, parsedSupplierId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Verify the LPO really exists in Busy and take the amounts from there.
    const erpPool = await getErpPool();
    const [lpo] = await fetchBusyLpos(erpPool, { vchNos: [ordno], limit: 1 });
    if (!lpo) {
      return res.status(404).json({ error: `LPO "${ordno}" was not found in Busy. Save it in Busy first, then try again.` });
    }

    const code = busyCodeOf(supplier);
    const supplierMatches = code
      ? lpo.supplierCode === code
      : String(lpo.supplier || '').trim().toLowerCase() === String(supplier.SupplierName || '').trim().toLowerCase();
    if (!supplierMatches && !confirmSupplierMismatch) {
      return res.status(409).json({
        code: 'SUPPLIER_MISMATCH',
        error: `Busy LPO ${lpo.ordno} is for "${lpo.supplier}", but this award is for "${supplier.SupplierName}".`,
      });
    }

    const noteParts = [
      `Marked LPO raised in Busy from Awarded Suppliers page by ${req.user.fullName || req.user.username}.`,
      !supplierMatches ? `Supplier differs in Busy ("${lpo.supplier}") — confirmed by user.` : null,
      notes ? String(notes).trim() : null,
    ].filter(Boolean);

    const outcome = await createReconciliation(pool, {
      busyPurOrdNo: lpo.ordno,
      rfqId: parsedRfqId,
      quoteEvaluationId,
      // Same rule as the Awards page -> Reconciliation link: SupplierId is
      // only recorded for split awards (full awards match on RFQId alone).
      supplierId: isSplit ? parsedSupplierId : null,
      busySupplier: lpo.supplier,
      busyDate: lpo.date,
      totalActualAmt: lpo.totalAmt,
      notes: noteParts.join(' ').substring(0, 1000),
      reconciledByUserId: req.user.userId,
    });

    if (!outcome.created) {
      const status = outcome.reason.includes('already been reconciled') ? 409 : 404;
      return res.status(status).json({ error: outcome.reason });
    }

    await writeAuditLog({
      entityType: 'LPO', entityId: lpo.ordno, action: 'MarkRaisedInBusy',
      userId: req.user.userId,
      newValues: { rfqId: parsedRfqId, supplierId: parsedSupplierId, awardType, busyOrdNo: lpo.ordno, totalAmt: lpo.totalAmt },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ record: outcome.record, lpo });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/busy-lpo/raised?search=&dateFrom=&dateTo= ───────────
// Every LPO linked to our system (marked raised, reconciled manually, or
// auto-reconciled), enriched with its live Busy status.
router.get('/raised', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const { search, dateFrom, dateTo } = req.query;
    const pool = await getPool();
    const request = pool.request();
    let where = '1=1';
    if (dateFrom) { where += ' AND rec.BusyDate >= @dateFrom'; request.input('dateFrom', sql.Date, dateFrom); }
    if (dateTo)   { where += ' AND rec.BusyDate <= @dateTo';   request.input('dateTo', sql.Date, dateTo); }
    if (search) {
      where += ` AND (rec.BusyPurOrdNo LIKE @search OR rec.BusySupplier LIKE @search
                 OR rfq.RFQNumber LIKE @search OR reqAgg.BusyOrdNoList LIKE @search)`;
      request.input('search', sql.NVarChar(100), `%${String(search).trim()}%`);
    }

    const result = await request.query(`
      SELECT TOP 500
        rec.LPOReconciliationId, LTRIM(RTRIM(rec.BusyPurOrdNo)) AS BusyPurOrdNo, rec.BusySupplier, rec.BusyDate,
        rec.TotalQuotedAmt, rec.TotalActualAmt, rec.VarianceAmt, rec.Notes, rec.ReconciledAt,
        rec.RFQId, rfq.RFQNumber,
        reqAgg.BusyOrdNoList AS RequisitionOrdNo,
        COALESCE(splitSup.SupplierName, s.SupplierName) AS AwardedSupplierName,
        u.FullName AS MarkedByName,
        CASE WHEN rec.ReconciledByUserId IS NULL THEN 'Auto-matched'
             WHEN rec.Notes LIKE 'Marked LPO raised in Busy%' THEN 'Marked raised'
             ELSE 'Manual reconciliation' END AS Source
      FROM dbo.LPOReconciliation rec
      LEFT JOIN dbo.Requisitions legacyReq ON legacyReq.RequisitionId = rec.RequisitionId
      LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = COALESCE(rec.RFQId, legacyReq.RFQId)
      OUTER APPLY (
        SELECT STRING_AGG(r2.BusyOrdNo, ', ') AS BusyOrdNoList
        FROM dbo.Requisitions r2
        WHERE r2.RFQId = COALESCE(rec.RFQId, legacyReq.RFQId)
      ) reqAgg
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.QuoteEvaluationId = rec.QuoteEvaluationId
      LEFT JOIN dbo.Quotations q ON q.QuotationId = ev.WinningQuotationId
      LEFT JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
      LEFT JOIN dbo.Suppliers splitSup ON splitSup.SupplierId = rec.SupplierId
      LEFT JOIN dbo.Users u ON u.UserId = rec.ReconciledByUserId
      WHERE ${where}
      ORDER BY rec.ReconciledAt DESC
    `);
    const rows = result.recordset;

    // Live Busy status — non-fatal if Busy is unreachable; the page still
    // shows what we stored.
    let busyByOrdno = {};
    let busyError = null;
    try {
      const erpPool = await getErpPool();
      const ordnos = [...new Set(rows.map((r) => r.BusyPurOrdNo).filter(Boolean))];
      for (let i = 0; i < ordnos.length; i += 200) {
        const chunk = ordnos.slice(i, i + 200);
        const lpos = await fetchBusyLpos(erpPool, { vchNos: chunk, limit: chunk.length });
        for (const l of lpos) busyByOrdno[l.ordno] = l;
      }
    } catch (e) {
      busyError = 'Busy is unreachable right now — showing stored details only.';
    }

    res.json({
      busyError,
      data: rows.map((r) => ({ ...r, busy: busyByOrdno[r.BusyPurOrdNo] || null })),
    });
  } catch (err) { next(err); }
});

// ── Raise the PO in Busy from here ───────────────────────────────────────────
// Body/query: { rfqId, quoteEvaluationId, supplierId, awardType, taxType?, storeOverride? }
// storeOverride: Busy store used for lines whose requisition store isn't a
// Busy store (e.g. manual requisitions raised for "ENGINEERING").

function parsePushParams(src) {
  return {
    rfqId: parseInt(src.rfqId, 10),
    quoteEvaluationId: parseInt(src.quoteEvaluationId, 10),
    supplierId: parseInt(src.supplierId, 10),
    awardType: src.awardType === 'split' ? 'split' : 'full',
    taxType: src.taxType ? String(src.taxType) : undefined,
    storeOverride: src.storeOverride ? String(src.storeOverride).trim() : undefined,
  };
}

async function awardAlreadyLinked(pool, { rfqId, supplierId, awardType }) {
  const result = await pool.request()
    .input('rfqId', sql.Int, rfqId)
    .input('supplierId', sql.Int, supplierId)
    .input('isSplit', sql.Bit, awardType === 'split' ? 1 : 0)
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(BusyPurOrdNo)) AS BusyPurOrdNo FROM dbo.LPOReconciliation
      WHERE RFQId = @rfqId AND (@isSplit = 0 OR SupplierId = @supplierId)
    `);
  return result.recordset[0]?.BusyPurOrdNo || null;
}

// The Busy login recorded as "Added by" for POs this user raises (Users.BusyUserName).
// Only a login the user has proved with their Busy password counts
// (Users.BusyUserVerifiedAt, 2026-10-19) — raising a PO requires one, so
// Busy never records a pushed PO as Supervisor.
async function getRaisingBusyUser(pool, erpPool, userId) {
  const r = await pool.request().input('id', sql.Int, userId)
    .query('SELECT BusyUserName, BusyUserVerifiedAt FROM dbo.Users WHERE UserId = @id');
  const u = r.recordset[0];
  if (!u?.BusyUserVerifiedAt) return null;
  return resolveBusyUser(erpPool, u.BusyUserName);
}

const BUSY_LINK_PROBLEM = 'Link your own Busy login first (your Busy user name and password) so Busy records you as the person who raised this PO.';

// Awards currently being pushed — stops a double click raising two POs.
const pushesInFlight = new Set();

// ── GET /api/procurement/busy-lpo/push-preview ───────────────────────────────
// Exactly what would be sent to Busy, resolved against Busy's masters, with
// any blocking problems. Nothing is written.
router.get('/push-preview', authenticate, authorize(...MARK_ROLES), async (req, res, next) => {
  try {
    const params = parsePushParams(req.query);
    if (!params.rfqId || !params.quoteEvaluationId || !params.supplierId) {
      return res.status(400).json({ error: 'rfqId, quoteEvaluationId and supplierId are required' });
    }
    if (!config.busyCom.enabled) {
      return res.json({ enabled: false, problems: ['Raising POs in Busy from this system is not switched on yet.'] });
    }
    const pool = await getPool();
    const erpPool = await getErpPool();
    const po = await buildPurchaseOrder(pool, erpPool, { ...params, seriesName: config.busyCom.poSeriesName });
    const linked = await awardAlreadyLinked(pool, params);
    if (linked) po.problems.unshift(`This award is already linked to Busy LPO ${linked}.`);
    delete po.xml;
    const stores = po.needsStore ? await listBusyStores(erpPool) : [];
    const busyUser = await getRaisingBusyUser(pool, erpPool, req.user.userId);
    if (!busyUser) po.problems.push(BUSY_LINK_PROBLEM);
    res.json({ enabled: true, ...po, stores, busyUser, needsBusyLink: !busyUser });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/busy-lpo/push ──────────────────────────────────────
// Saves the PO in Busy (Busy assigns the number), then links it to the
// award exactly like /mark-raised does.
router.post('/push', authenticate, authorize(...MARK_ROLES), async (req, res, next) => {
  const params = parsePushParams(req.body);
  const lockKey = `${params.rfqId}:${params.awardType === 'split' ? params.supplierId : '*'}`;
  let locked = false;
  try {
    if (!params.rfqId || !params.quoteEvaluationId || !params.supplierId) {
      return res.status(400).json({ error: 'rfqId, quoteEvaluationId and supplierId are required' });
    }
    if (!config.busyCom.enabled) {
      return res.status(503).json({ error: 'Raising POs in Busy from this system is not switched on yet.' });
    }
    if (pushesInFlight.has(lockKey)) {
      return res.status(409).json({ error: 'This PO is already being raised in Busy — wait a moment.' });
    }
    pushesInFlight.add(lockKey);
    locked = true;

    const pool = await getPool();
    const erpPool = await getErpPool();

    const linked = await awardAlreadyLinked(pool, params);
    if (linked) return res.status(409).json({ error: `This award is already linked to Busy LPO ${linked}` });

    const busyUser = await getRaisingBusyUser(pool, erpPool, req.user.userId);
    if (!busyUser) return res.status(403).json({ error: BUSY_LINK_PROBLEM, needsBusyLink: true });

    const po = await buildPurchaseOrder(pool, erpPool, { ...params, seriesName: config.busyCom.poSeriesName });
    if (po.problems.length > 0) return res.status(422).json({ error: po.problems[0], problems: po.problems });

    // A previous push may have saved in Busy and then failed on our side —
    // link that PO instead of raising a second one.
    let vchNo = await findExistingPushedPo(erpPool, { rfqNumber: po.rfqNumber, partyCode: po.party.Code });
    let reused = !!vchNo;
    let approvalWarning = null;
    let userWarning = null;
    if (!vchNo) {
      const saved = await busyBridge.addVoucher(PO_VCHTYPE, po.xml);
      if (!saved.ok) {
        logger.warn(`[BusyPush] Busy rejected PO for RFQ ${po.rfqNumber} / ${po.supplierName}: ${saved.error}`);
        return res.status(502).json({ error: `Busy did not save the PO: ${saved.error}` });
      }
      vchNo = saved.vchNo;
      logger.info(`[BusyPush] Busy saved ${vchNo} (VchCode ${saved.vchCode}) for RFQ ${po.rfqNumber} / ${po.supplierName}`);
      try {
        await markPendingApproval(erpPool, saved.vchCode);
      } catch (err) {
        approvalWarning = `${vchNo} was saved in Busy but could not be set to "pending approval" — it is already approved.`;
        logger.error(`[BusyPush] Could not set ${vchNo} pending approval: ${err.message}`);
      }
      try {
        const busyUser = await getRaisingBusyUser(pool, erpPool, req.user.userId);
        if (busyUser) await attributeToBusyUser(erpPool, { vchCode: saved.vchCode, vchNo, busyUserName: busyUser });
        else userWarning = `${vchNo} shows as added by Supervisor in Busy — ask an Admin to link your account to your Busy user in User Management.`;
      } catch (err) {
        userWarning = `${vchNo} shows as added by Supervisor in Busy — could not record who raised it.`;
        logger.error(`[BusyPush] Could not set Busy "added by" on ${vchNo}: ${err.message}`);
      }
    }

    // Read the PO back from Busy — amounts stored come from Busy, never from us.
    const [lpo] = await fetchBusyLpos(erpPool, { vchNos: [vchNo], limit: 1 });
    if (!lpo) {
      return res.status(502).json({ error: `Busy reported saving ${vchNo} but it can't be read back. Check Busy, then use "Mark raised".` });
    }
    let totalWarning = null;
    if (!reused && Math.abs(lpo.grandTotal - po.total) > 0.5) {
      totalWarning = `Busy's total for ${lpo.ordno} is ${lpo.grandTotal}, expected ${po.total}. Check the PO in Busy before approving.`;
      logger.warn(`[BusyPush] ${totalWarning}`);
    }

    const outcome = await createReconciliation(pool, {
      busyPurOrdNo: lpo.ordno,
      rfqId: params.rfqId,
      quoteEvaluationId: params.quoteEvaluationId,
      supplierId: params.awardType === 'split' ? params.supplierId : null,
      busySupplier: lpo.supplier,
      busyDate: lpo.date,
      totalActualAmt: lpo.totalAmt,
      notes: `Raised in Busy from Awarded Suppliers page by ${req.user.fullName || req.user.username} (${po.taxType}).`,
      reconciledByUserId: req.user.userId,
    });
    if (!outcome.created) {
      return res.status(500).json({ error: `PO ${lpo.ordno} was saved in Busy but could not be linked: ${outcome.reason}. Use "Mark raised" with ${lpo.ordno}.`, lpo });
    }

    await writeAuditLog({
      entityType: 'LPO', entityId: lpo.ordno, action: reused ? 'LinkPushedToBusy' : 'RaisedInBusy',
      userId: req.user.userId,
      newValues: { ...params, busyOrdNo: lpo.ordno, taxType: po.taxType, expectedTotal: po.total, busyGrandTotal: lpo.grandTotal },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ record: outcome.record, lpo, expectedTotal: po.total, reused, approvalWarning, totalWarning, userWarning });
  } catch (err) {
    next(err);
  } finally {
    if (locked) pushesInFlight.delete(lockKey);
  }
});

// ── Transport fuel orders (2026-10-19) ───────────────────────────────────────
// A fuel requisition goes straight to Procurement, who raise the Busy PO from
// it directly — no RFQ or award. Same safeguards as /push: preview first,
// double-click lock, retry links the PO already saved, amounts read back
// from Busy, and the requisition is closed through createReconciliation.

async function requisitionAlreadyLinked(pool, requisitionId) {
  const result = await pool.request().input('id', sql.Int, requisitionId).query(
    'SELECT TOP 1 LTRIM(RTRIM(BusyPurOrdNo)) AS BusyPurOrdNo FROM dbo.LPOReconciliation WHERE RequisitionId = @id');
  return result.recordset[0]?.BusyPurOrdNo || null;
}

function parseFuelParams(src) {
  return { requisitionId: parseInt(src.requisitionId, 10), supplierId: parseInt(src.supplierId, 10) || null };
}

// ── GET /api/procurement/busy-lpo/fuel-preview?requisitionId=&supplierId= ───
router.get('/fuel-preview', authenticate, authorize(...MARK_ROLES), async (req, res, next) => {
  try {
    const params = parseFuelParams(req.query);
    if (!params.requisitionId) return res.status(400).json({ error: 'requisitionId is required' });
    if (!config.busyCom.enabled) {
      return res.json({ enabled: false, problems: ['Raising POs in Busy from this system is not switched on yet.'] });
    }
    const pool = await getPool();
    const erpPool = await getErpPool();
    const po = await buildFuelPurchaseOrder(pool, erpPool, { ...params, seriesName: config.busyCom.poSeriesName });
    const linked = await requisitionAlreadyLinked(pool, params.requisitionId);
    if (linked) po.problems.unshift(`This requisition is already linked to Busy LPO ${linked}.`);
    delete po.xml;
    const [suppliers, busyUser] = await Promise.all([
      listFuelSuppliers(pool, erpPool),
      getRaisingBusyUser(pool, erpPool, req.user.userId),
    ]);
    if (!busyUser) po.problems.push(BUSY_LINK_PROBLEM);
    res.json({ enabled: true, ...po, suppliers, busyUser, needsBusyLink: !busyUser });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/busy-lpo/fuel-push  { requisitionId, supplierId } ──
router.post('/fuel-push', authenticate, authorize(...MARK_ROLES), async (req, res, next) => {
  const params = parseFuelParams(req.body);
  const lockKey = `req:${params.requisitionId}`;
  let locked = false;
  try {
    if (!params.requisitionId || !params.supplierId) {
      return res.status(400).json({ error: 'requisitionId and supplierId are required' });
    }
    if (!config.busyCom.enabled) {
      return res.status(503).json({ error: 'Raising POs in Busy from this system is not switched on yet.' });
    }
    if (pushesInFlight.has(lockKey)) {
      return res.status(409).json({ error: 'This PO is already being raised in Busy — wait a moment.' });
    }
    pushesInFlight.add(lockKey);
    locked = true;

    const pool = await getPool();
    const erpPool = await getErpPool();

    const linked = await requisitionAlreadyLinked(pool, params.requisitionId);
    if (linked) return res.status(409).json({ error: `This requisition is already linked to Busy LPO ${linked}` });

    const busyUser = await getRaisingBusyUser(pool, erpPool, req.user.userId);
    if (!busyUser) return res.status(403).json({ error: BUSY_LINK_PROBLEM, needsBusyLink: true });

    const po = await buildFuelPurchaseOrder(pool, erpPool, { ...params, seriesName: config.busyCom.poSeriesName });
    if (po.problems.length > 0) return res.status(422).json({ error: po.problems[0], problems: po.problems });

    let vchNo = await findExistingPushedPo(erpPool, { rfqNumber: po.requisitionNo, partyCode: po.party.Code });
    const reused = !!vchNo;
    let approvalWarning = null;
    let userWarning = null;
    if (!vchNo) {
      const saved = await busyBridge.addVoucher(PO_VCHTYPE, po.xml);
      if (!saved.ok) {
        logger.warn(`[BusyPush] Busy rejected fuel PO for ${po.requisitionNo} / ${po.supplierName}: ${saved.error}`);
        return res.status(502).json({ error: `Busy did not save the PO: ${saved.error}` });
      }
      vchNo = saved.vchNo;
      logger.info(`[BusyPush] Busy saved ${vchNo} (VchCode ${saved.vchCode}) for fuel ${po.requisitionNo} / ${po.vehicle} / ${po.supplierName}`);
      try {
        await markPendingApproval(erpPool, saved.vchCode);
      } catch (err) {
        approvalWarning = `${vchNo} was saved in Busy but could not be set to "pending approval" — it is already approved.`;
        logger.error(`[BusyPush] Could not set ${vchNo} pending approval: ${err.message}`);
      }
      try {
        const busyUser = await getRaisingBusyUser(pool, erpPool, req.user.userId);
        if (busyUser) await attributeToBusyUser(erpPool, { vchCode: saved.vchCode, vchNo, busyUserName: busyUser });
        else userWarning = `${vchNo} shows as added by Supervisor in Busy — ask an Admin to link your account to your Busy user in User Management.`;
      } catch (err) {
        userWarning = `${vchNo} shows as added by Supervisor in Busy — could not record who raised it.`;
        logger.error(`[BusyPush] Could not set Busy "added by" on ${vchNo}: ${err.message}`);
      }
    }

    const [lpo] = await fetchBusyLpos(erpPool, { vchNos: [vchNo], limit: 1 });
    if (!lpo) {
      return res.status(502).json({ error: `Busy reported saving ${vchNo} but it can't be read back. Check Busy before raising it again.` });
    }
    let totalWarning = null;
    if (!reused && Math.abs(lpo.grandTotal - po.total) > 0.5) {
      totalWarning = `Busy's total for ${lpo.ordno} is ${lpo.grandTotal}, expected ${po.total}. Check the PO in Busy before approving.`;
      logger.warn(`[BusyPush] ${totalWarning}`);
    }

    const outcome = await createReconciliation(pool, {
      busyPurOrdNo: lpo.ordno,
      requisitionId: params.requisitionId,
      supplierId: params.supplierId,
      busySupplier: lpo.supplier,
      busyDate: lpo.date,
      totalActualAmt: lpo.totalAmt,
      notes: `Fuel for ${po.vehicle || po.store} raised in Busy from Requisitions by ${req.user.fullName || req.user.username}${po.litresOpen ? ' (litres open)' : ''}.`,
      reconciledByUserId: req.user.userId,
    });
    if (!outcome.created) {
      return res.status(500).json({ error: `PO ${lpo.ordno} was saved in Busy but could not be linked: ${outcome.reason}.`, lpo });
    }

    await writeAuditLog({
      entityType: 'Requisition', entityId: params.requisitionId, action: reused ? 'LinkPushedToBusy' : 'RaisedInBusy',
      userId: req.user.userId,
      newValues: { ...params, orderType: 'Fuel', vehicle: po.vehicle, busyOrdNo: lpo.ordno, expectedTotal: po.total, busyGrandTotal: lpo.grandTotal },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ record: outcome.record, lpo, expectedTotal: po.total, reused, approvalWarning, totalWarning, userWarning });
  } catch (err) {
    next(err);
  } finally {
    if (locked) pushesInFlight.delete(lockKey);
  }
});

module.exports = router;
