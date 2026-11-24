const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize, authorizeStrict } = require('../middleware/auth');
const { getErpPool } = require('../erpDb');
const { buildRequisitionAudit } = require('../services/requisition-audit.service');

const router = express.Router();

// ──── GET /api/reports/traceability/:entryNo — Full journey ────
router.get('/traceability/:entryNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const { entryNo } = req.params;

    // Entry
    const entry = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query(`SELECT de.*, s.SupplierName, s.SupplierCode, u.FullName AS CreatedByName
              FROM dbo.DeliveryEntries de
              JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
              JOIN dbo.Users u ON u.UserId = de.CreatedBy
              WHERE de.EntryNo = @entryNo`);

    if (!entry.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const e = entry.recordset[0];

    // Fetch all child data in parallel
    const [items, wb, grns, history, qa, rejection] = await Promise.all([
      pool.request()
        .input('entryId', sql.Int, e.EntryId)
        .query(`SELECT dei.*, m.MaterialCode, m.MaterialName
                FROM dbo.DeliveryEntryItems dei
                JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
                WHERE dei.EntryId = @entryId`),
      pool.request()
        .input('entryId2', sql.Int, e.EntryId)
        .query(`SELECT wr.*, u.FullName AS OperatorName, m.MaterialName
                FROM dbo.WeighbridgeRecords wr
                JOIN dbo.Users u ON u.UserId = wr.OperatorId
                LEFT JOIN dbo.DeliveryEntryItems dei ON dei.EntryItemId = wr.EntryItemId
                LEFT JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
                WHERE wr.EntryId = @entryId2
                ORDER BY wr.WeighbridgeId`),
      pool.request()
        .input('entryId3', sql.Int, e.EntryId)
        .query(`SELECT g.*, u.FullName AS ReceivedByName, sl.LocationName,
                       ru.FullName AS ReversedByName
                FROM dbo.GoodsReceiptNotes g
                JOIN dbo.Users u ON u.UserId = g.ReceivedBy
                LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
                LEFT JOIN dbo.Users ru ON ru.UserId = g.ReversedBy
                WHERE g.EntryId = @entryId3
                ORDER BY g.CreatedAt`),
      pool.request()
        .input('eId', sql.Int, e.EntryId)
        .query(`SELECT sh.*, u.FullName AS ChangedByName
                FROM dbo.StatusHistory sh
                JOIN dbo.Users u ON u.UserId = sh.ChangedBy
                WHERE (sh.EntityType = 'DeliveryEntry' AND sh.EntityId = @eId)
                   OR (sh.EntityType = 'GRN' AND sh.EntityId IN (SELECT GRNId FROM dbo.GoodsReceiptNotes WHERE EntryId = @eId))
                   OR (sh.EntityType = 'QAInspection' AND sh.EntityId IN (SELECT InspectionId FROM dbo.QAInspections WHERE EntryId = @eId))
                ORDER BY sh.ChangedAt`),
      pool.request()
        .input('entryId4', sql.Int, e.EntryId)
        // Latest inspection only — an entry the Ops Manager sent back for
        // re-inspection can have more than one row, and qa.recordset[0]
        // below is used as THE inspection (its InspectionId also drives
        // the qaTests lookup), so it must be the most recent one.
        .query(`SELECT TOP 1 qi.*, u.FullName AS InspectorName, ua.FullName AS ApprovedByName
                FROM dbo.QAInspections qi
                JOIN dbo.Users u ON u.UserId = qi.InspectorId
                LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
                WHERE qi.EntryId = @entryId4
                ORDER BY qi.InspectionId DESC`),
      pool.request()
        .input('entryId5', sql.Int, e.EntryId)
        .query(`SELECT gr.*, u.FullName AS RejectedByName
                FROM dbo.GoodsRejectionNotes gr
                JOIN dbo.Users u ON u.UserId = gr.RejectedBy
                WHERE gr.EntryId = @entryId5`),
    ]);

    let qaTests = [];
    if (qa.recordset[0]) {
      const testsResult = await pool.request()
        .input('inspId', sql.Int, qa.recordset[0].InspectionId)
        .query(`SELECT tr.*, m.MaterialCode, m.MaterialName, u.FullName AS TestedByName
                FROM dbo.QATestResults tr
                JOIN dbo.Materials m ON m.MaterialId = tr.MaterialId
                JOIN dbo.Users u ON u.UserId = tr.TestedBy
                WHERE tr.InspectionId = @inspId ORDER BY tr.TestedAt`);
      qaTests = testsResult.recordset;
    }

    res.json({
      entry: e,
      items: items.recordset,
      weighbridge: wb.recordset[0] || null,
      weighings: wb.recordset, // every weighing of the truck (one per material, or one for a load weighed together)
      qaInspection: qa.recordset[0] || null,
      qaTests,
      grns: grns.recordset,
      rejection: rejection.recordset[0] || null,
      statusHistory: history.recordset,
    });
  } catch (err) { next(err); }
});

// ──── GET /api/reports/audit-logs ────
router.get('/audit-logs', authenticate, authorizeStrict('Admin', 'Auditor'), async (req, res, next) => {
  try {
    const { entityType, entityId, userId, action, dateFrom, dateTo, page = 1, limit = 100 } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = '1=1';
    if (entityType) { where += ' AND al.EntityType = @entityType'; request.input('entityType', sql.VarChar(30), entityType); }
    if (entityId) { where += ' AND al.EntityId = @entityId'; request.input('entityId', sql.VarChar(50), entityId); }
    if (userId) { where += ' AND al.UserId = @userId'; request.input('userId', sql.Int, parseInt(userId)); }
    if (action) { where += ' AND al.Action = @action'; request.input('action', sql.VarChar(30), action); }
    if (dateFrom) { where += ' AND al.Timestamp >= @dateFrom'; request.input('dateFrom', sql.DateTime2, dateFrom); }
    if (dateTo) { where += ' AND al.Timestamp <= @dateTo'; request.input('dateTo', sql.DateTime2, dateTo); }

    request.input('offset', sql.Int, (parseInt(page) - 1) * parseInt(limit));
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT al.*, u.FullName AS UserName, u.Username
      FROM dbo.AuditLogs al
      JOIN dbo.Users u ON u.UserId = al.UserId
      WHERE ${where}
      ORDER BY al.Timestamp DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── GET /api/reports/dashboard ────
router.get('/dashboard', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();

    const [entryStatsResult, grnStatsResult, recentResult] = await Promise.all([
      pool.request().query(`
        SELECT
          ISNULL(SUM(CASE WHEN Status = 'GateReceived' THEN 1 ELSE 0 END), 0) AS pendingWeighbridge,
          ISNULL(SUM(CASE WHEN Status = 'WeighbridgeCompleted' THEN 1 ELSE 0 END), 0) AS pendingReceiving,
          ISNULL(SUM(CASE WHEN Status IN ('QAPending','QAInProgress','Quarantine') THEN 1 ELSE 0 END), 0) AS pendingQA,
          ISNULL(SUM(CASE WHEN Status = 'QAAccepted' THEN 1 ELSE 0 END), 0) AS qaAccepted,
          ISNULL(SUM(CASE WHEN Status IN ('QARejected','Rejected') THEN 1 ELSE 0 END), 0) AS qaRejected,
          ISNULL(SUM(CASE WHEN CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS todayEntries,
          ISNULL(SUM(CASE WHEN Status = 'GRNCreated' THEN 1 ELSE 0 END), 0) AS completedToday
        FROM dbo.DeliveryEntries
      `),
      pool.request().query(`
        SELECT
          ISNULL(SUM(CASE WHEN CAST(ReceivedAt AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS todayGRNs,
          ISNULL(SUM(CASE WHEN GRNStatus = 'Reversed' AND CAST(ReversedAt AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS todayReversals
        FROM dbo.GoodsReceiptNotes
      `),
      pool.request().query(`
        SELECT TOP 10 de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.Status, de.CreatedAt,
               s.SupplierName
        FROM dbo.DeliveryEntries de
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        ORDER BY de.CreatedAt DESC
      `),
    ]);

    const entryStats = entryStatsResult.recordset[0] || {};
    const grnStats = grnStatsResult.recordset[0] || {};

    res.json({
      stats: { ...entryStats, ...grnStats },
      recentEntries: recentResult.recordset,
    });
  } catch (err) { next(err); }
});

// ──── GET /api/reports/requisition-audit?from=&to=&factory= ────
// Every requisition line (all factories) with stock at the time of request,
// its approval → award → PO → receipt chain and audit red flags.
// Viewers may read it too (authorize lets them through on GET).
const AUDIT_ROLES = ['Admin', 'Auditor', 'Director', 'OpsManager', 'Procurement', 'Viewer'];
const auditCache = new Map();
let auditInFlight = null;
router.get('/requisition-audit', authenticate, authorize(...AUDIT_ROLES), async (req, res, next) => {
  let mine = null;
  try {
    const now = new Date();
    const fyStart = new Date(now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1, 4, 1);
    const parse = (v, d) => { const x = v ? new Date(v) : null; return x && !Number.isNaN(x.getTime()) ? x : d; };
    const from = parse(req.query.from, fyStart);
    const to = parse(req.query.to, now);
    const factory = String(req.query.factory || '').trim() || null;
    const key = `${from.toISOString().slice(0, 10)}|${to.toISOString().slice(0, 10)}|${factory || ''}`;
    const hit = auditCache.get(key);
    if (hit && Date.now() - hit.at < 3 * 60e3 && req.query.refresh !== '1') return res.json(hit.data);

    // One build at a time — it reads the whole period's stock ledger from Busy.
    while (auditInFlight) await auditInFlight.catch(() => {});
    const again = auditCache.get(key); // built by the request we waited for
    if (again && Date.now() - again.at < 3 * 60e3 && req.query.refresh !== '1') return res.json(again.data);
    mine = buildRequisitionAudit(await getPool(), await getErpPool(), { from, to, factory });
    auditInFlight = mine;
    const data = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), factory, generatedAt: new Date(), ...(await mine) };
    if (auditCache.size > 20) auditCache.clear();
    auditCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (err) { next(err); } finally { if (mine && auditInFlight === mine) auditInFlight = null; }
});

module.exports = router;
