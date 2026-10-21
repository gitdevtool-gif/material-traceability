const express = require('express');
const crypto = require('crypto');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');
const { sendOpsApprovalEmail } = require('../services/email.service');
const config = require('../config');
const logger = require('../logger');

const router = express.Router();

// ──── Helper: extract factory identifier from user email ────
// e.g. f1production@njorocanning.co.ke → 'F1', f2production@... → 'F2', etc.
// Returns null if email doesn't match the factory pattern
function extractFactoryFromEmail(email) {
  if (!email) return null;
  const match = email.toLowerCase().match(/^f(\d+)production@/);
  return match ? `F${match[1]}` : null;
}

// ──── Helper: check if user can see all factories ────
function canSeeAllFactories(role) {
  return ['Admin', 'Supervisor', 'QAManager', 'Viewer'].includes(role);
}

// ──── Helper: generate next QA Inspection No ────
async function generateInspectionNo(transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = new sql.Request(transaction);
  const result = await req
    .input('seqType', sql.VarChar(20), 'QA')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);
  const seq = result.recordset[0].LastNumber;
  return `QA-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── POST /api/qa — Create QA Inspection ────
router.post('/', authenticate, authorize('QAInspector', 'QAManager', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const { entryNo, coaProvided, coaReference, samplesTaken, physicalCheckDone, vehicleInspectionDone, remarks } = req.body;
    if (!entryNo) return res.status(400).json({ error: 'entryNo is required' });

    const pool = await getPool();

    // Validate entry status
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query(`SELECT de.EntryId, de.Status, de.VersionNo, de.LocationId, sl.LocationName
              FROM dbo.DeliveryEntries de
              LEFT JOIN dbo.StockLocations sl ON sl.LocationId = de.LocationId
              WHERE de.EntryNo = @entryNo`);
    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    // Factory access check
    if (!canSeeAllFactories(req.user.role)) {
      const factoryId = extractFactoryFromEmail(req.user.email);
      if (factoryId && entry.LocationName && !entry.LocationName.toUpperCase().includes(factoryId.toUpperCase())) {
        return res.status(403).json({ error: 'You can only inspect entries for your factory' });
      }
    }

    if (!['WeighbridgeCompleted', 'QAPending'].includes(entry.Status)) {
      return res.status(400).json({ error: `Cannot start QA — entry status is ${entry.Status}. Must be WeighbridgeCompleted or QAPending.` });
    }

    // Check no existing active inspection
    const existing = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query("SELECT InspectionId FROM dbo.QAInspections WHERE EntryId = @entryId AND OverallStatus NOT IN ('Rejected')");
    if (existing.recordset.length > 0) {
      return res.status(409).json({ error: 'An active QA inspection already exists for this entry' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const inspNo = await generateInspectionNo(transaction);

      const insReq = new sql.Request(transaction);
      const result = await insReq
        .input('inspNo', sql.VarChar(20), inspNo)
        .input('entryId', sql.Int, entry.EntryId)
        .input('inspectorId', sql.Int, req.user.userId)
        .input('coaProvided', sql.Bit, coaProvided ? 1 : 0)
        .input('coaReference', sql.VarChar(100), coaReference || null)
        .input('samplesTaken', sql.Bit, samplesTaken ? 1 : 0)
        .input('physicalCheckDone', sql.Bit, physicalCheckDone ? 1 : 0)
        .input('vehicleInspectionDone', sql.Bit, vehicleInspectionDone ? 1 : 0)
        .input('remarks', sql.NVarChar(1000), remarks || null)
        .query(`INSERT INTO dbo.QAInspections
          (InspectionNo, EntryId, InspectorId, OverallStatus, COAProvided, COAReference, SamplesTaken, PhysicalCheckDone, VehicleInspectionDone, OverallRemarks)
          OUTPUT INSERTED.InspectionId, INSERTED.InspectionNo, INSERTED.OverallStatus, INSERTED.InspectionDate
          VALUES (@inspNo, @entryId, @inspectorId, 'Pending', @coaProvided, @coaReference, @samplesTaken, @physicalCheckDone, @vehicleInspectionDone, @remarks)`);

      const inspection = result.recordset[0];

      // Update entry status to QAPending
      const statusReq = new sql.Request(transaction);
      await statusReq
        .input('entryId', sql.Int, entry.EntryId)
        .input('versionNo', sql.Int, entry.VersionNo)
        .query(`UPDATE dbo.DeliveryEntries SET Status = 'QAPending', VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId AND VersionNo = @versionNo`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'QAInspection', entityId: inspection.InspectionId, action: 'Create',
        userId: req.user.userId, newValues: { inspNo, entryNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: entry.Status, toStatus: 'QAPending', changedBy: req.user.userId,
        remarks: `QA inspection ${inspNo} created`,
      });

      res.status(201).json({ ...inspection, entryNo });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── POST /api/qa/:inspectionNo/tests — Add test results ────
router.post('/:inspectionNo/tests', authenticate, authorize('QAInspector', 'QAManager', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const { tests } = req.body; // array of { materialId, testName, testMethod, expectedValue, actualValue, result, remarks }
    if (!tests || !tests.length) return res.status(400).json({ error: 'tests array is required' });

    // Validate every row up front — MaterialId and TestName are NOT NULL
    // columns on QATestResults, so a bad value here would otherwise surface
    // as a raw SQL constraint error (500) instead of a clear message. This
    // came up for real when an entry had no DeliveryEntryItems recorded —
    // the frontend's material dropdown had nothing to offer, so it
    // submitted a blank materialId.
    const badRows = [];
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      const materialId = parseInt(t.materialId, 10);
      if (!Number.isInteger(materialId) || materialId <= 0) badRows.push(`row ${i + 1}: materialId is missing or invalid`);
      else if (!t.testName || !String(t.testName).trim()) badRows.push(`row ${i + 1}: testName is required`);
    }
    if (badRows.length > 0) {
      return res.status(400).json({ error: `Invalid test row(s) — ${badRows.join('; ')}` });
    }

    const pool = await getPool();
    const insp = await pool.request()
      .input('inspNo', sql.VarChar(20), req.params.inspectionNo)
      .query('SELECT InspectionId, OverallStatus FROM dbo.QAInspections WHERE InspectionNo = @inspNo');
    if (!insp.recordset[0]) return res.status(404).json({ error: 'Inspection not found' });
    const inspection = insp.recordset[0];

    if (['Accepted', 'Rejected'].includes(inspection.OverallStatus)) {
      return res.status(400).json({ error: 'Cannot add tests to a finalized inspection' });
    }

    // Verify every materialId actually exists — a stale/removed material
    // id from the frontend would otherwise fail as an FK violation deep in
    // the insert loop, again surfacing as a raw 500.
    const materialIds = [...new Set(tests.map((t) => parseInt(t.materialId, 10)))];
    const placeholders = materialIds.map((_, i) => `@m${i}`).join(',');
    const matCheckReq = pool.request();
    materialIds.forEach((id, i) => matCheckReq.input(`m${i}`, sql.Int, id));
    const matCheck = await matCheckReq.query(`SELECT MaterialId FROM dbo.Materials WHERE MaterialId IN (${placeholders})`);
    if (matCheck.recordset.length !== materialIds.length) {
      return res.status(400).json({ error: 'One or more selected materials were not found' });
    }

    // Update status to InProgress
    await pool.request()
      .input('inspId', sql.Int, inspection.InspectionId)
      .query("UPDATE dbo.QAInspections SET OverallStatus = 'InProgress', UpdatedAt = GETUTCDATE() WHERE InspectionId = @inspId AND OverallStatus = 'Pending'");

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const inserted = [];
      for (const t of tests) {
        const r = await new sql.Request(transaction)
          .input('inspId', sql.Int, inspection.InspectionId)
          .input('materialId', sql.Int, parseInt(t.materialId, 10))
          .input('testName', sql.NVarChar(100), t.testName)
          .input('testMethod', sql.NVarChar(200), t.testMethod || null)
          .input('expectedValue', sql.NVarChar(100), t.expectedValue || null)
          .input('actualValue', sql.NVarChar(100), t.actualValue || null)
          .input('result', sql.VarChar(20), t.result || 'Pending')
          .input('remarks', sql.NVarChar(500), t.remarks || null)
          .input('testedBy', sql.Int, req.user.userId)
          .query(`INSERT INTO dbo.QATestResults
            (InspectionId, MaterialId, TestName, TestMethod, ExpectedValue, ActualValue, Result, Remarks, TestedBy)
            OUTPUT INSERTED.*
            VALUES (@inspId, @materialId, @testName, @testMethod, @expectedValue, @actualValue, @result, @remarks, @testedBy)`);
        inserted.push(r.recordset[0]);
      }
      await transaction.commit();
      res.status(201).json({ inspectionNo: req.params.inspectionNo, tests: inserted });
    } catch (err) {
      await transaction.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── PATCH /api/qa/:inspectionNo/decision — Accept / Reject / Quarantine ────
router.patch('/:inspectionNo/decision', authenticate, authorize('QAManager', 'FactoryQA', 'Supervisor', 'Admin'), async (req, res, next) => {
  try {
    const { decision, acceptedQty, rejectedQty, remarks } = req.body;
    if (!decision || !['Accepted', 'Rejected', 'Quarantine', 'Conditional'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Accepted, Rejected, Quarantine or Conditional' });
    }

    const pool = await getPool();
    const insp = await pool.request()
      .input('inspNo', sql.VarChar(20), req.params.inspectionNo)
      .query('SELECT InspectionId, EntryId, OverallStatus, VersionNo FROM dbo.QAInspections WHERE InspectionNo = @inspNo');
    if (!insp.recordset[0]) return res.status(404).json({ error: 'Inspection not found' });
    const inspection = insp.recordset[0];

    if (['Accepted', 'Rejected'].includes(inspection.OverallStatus)) {
      return res.status(400).json({ error: 'Inspection already finalized' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // Update inspection
      const updReq = new sql.Request(transaction);
      await updReq
        .input('inspId', sql.Int, inspection.InspectionId)
        .input('decision', sql.VarChar(20), decision)
        .input('acceptedQty', sql.Decimal(12, 2), acceptedQty || null)
        .input('rejectedQty', sql.Decimal(12, 2), rejectedQty || null)
        .input('remarks', sql.NVarChar(1000), remarks || null)
        .input('approvedBy', sql.Int, req.user.userId)
        .input('versionNo', sql.Int, inspection.VersionNo)
        .query(`UPDATE dbo.QAInspections
                SET OverallStatus = @decision, AcceptedQty = @acceptedQty, RejectedQty = @rejectedQty,
                    OverallRemarks = COALESCE(@remarks, OverallRemarks), ApprovedBy = @approvedBy, ApprovedAt = GETUTCDATE(),
                    VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE InspectionId = @inspId AND VersionNo = @versionNo`);

      // Map QA decision to entry status
      const statusMap = {
        'Accepted': 'QAAccepted',
        'Rejected': 'QARejected',
        'Quarantine': 'Quarantine',
        'Conditional': 'QAAccepted',  // conditional acceptance still proceeds
      };
      const newEntryStatus = statusMap[decision];

      const entryReq = new sql.Request(transaction);
      await entryReq
        .input('entryId', sql.Int, inspection.EntryId)
        .input('status', sql.VarChar(30), newEntryStatus)
        .query(`UPDATE dbo.DeliveryEntries SET Status = @status, VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'QAInspection', entityId: inspection.InspectionId, action: 'StatusChange',
        userId: req.user.userId, oldValues: { status: inspection.OverallStatus }, newValues: { status: decision },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: inspection.EntryId,
        fromStatus: 'QAPending', toStatus: newEntryStatus, changedBy: req.user.userId,
        remarks: `QA decision: ${decision}. ${remarks || ''}`,
      });

      res.json({ inspectionNo: req.params.inspectionNo, decision, entryStatus: newEntryStatus });

      // Auto-send Ops Manager approval email when QA accepts (fire-and-forget)
      if (['Accepted', 'Conditional'].includes(decision)) {
        (async () => {
          try {
            const entryData = await pool.request()
              .input('entryId', sql.Int, inspection.EntryId)
              .input('inspectionId', sql.Int, inspection.InspectionId)
              .query(`SELECT de.EntryNo, de.ConsignmentNo, de.VehicleRegNo,
                             s.SupplierName,
                             qi.AcceptedQty, qi.RejectedQty, qi.OverallRemarks AS QARemarks,
                             inspector.FullName AS InspectorName
                      FROM dbo.DeliveryEntries de
                      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
                      LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = @inspectionId
                      LEFT JOIN dbo.Users inspector ON inspector.UserId = qi.InspectorId
                      WHERE de.EntryId = @entryId`);
            const e = entryData.recordset[0];
            if (!e) return;

            const itemsData = await pool.request()
              .input('entryId', sql.Int, inspection.EntryId)
              .query('SELECT m.MaterialName FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId WHERE dei.EntryId = @entryId');
            const materialNames = itemsData.recordset.map(i => i.MaterialName).join(', ');

            // Fetch weighbridge ticket numbers
            const wbTickets = await pool.request()
              .input('entryId', sql.Int, inspection.EntryId)
              .query('SELECT TicketNo FROM dbo.WeighbridgeRecords WHERE EntryId = @entryId AND TicketNo IS NOT NULL');
            const ticketNos = wbTickets.recordset.length > 0
              ? wbTickets.recordset.map(r => r.TicketNo).join(', ')
              : null;

            // Generate tokens
            const approveToken = crypto.randomBytes(32).toString('hex');
            const rejectToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

            await pool.request()
              .input('token', sql.VarChar(100), approveToken)
              .input('entryId', sql.Int, inspection.EntryId)
              .input('entryNo', sql.VarChar(20), e.EntryNo)
              .input('expiresAt', sql.DateTime2, expiresAt)
              .query('INSERT INTO dbo.ApprovalTokens (Token, EntryId, EntryNo, ExpiresAt) VALUES (@token, @entryId, @entryNo, @expiresAt)');

            await pool.request()
              .input('token', sql.VarChar(100), rejectToken)
              .input('entryId', sql.Int, inspection.EntryId)
              .input('entryNo', sql.VarChar(20), e.EntryNo)
              .input('expiresAt', sql.DateTime2, expiresAt)
              .query('INSERT INTO dbo.ApprovalTokens (Token, EntryId, EntryNo, ExpiresAt) VALUES (@token, @entryId, @entryNo, @expiresAt)');

            await sendOpsApprovalEmail({
              to: config.email.opsManagerEmail,
              entryNo: e.EntryNo,
              supplierName: e.SupplierName,
              consignmentNo: e.ConsignmentNo,
              vehicleRegNo: e.VehicleRegNo,
              materialNames,
              ticketNos,
              acceptedQty: e.AcceptedQty,
              rejectedQty: e.RejectedQty,
              qaDecision: decision,
              qaRemarks: e.QARemarks,
              inspectorName: e.InspectorName,
              approveToken,
              rejectToken,
            });
          } catch (emailErr) {
            logger.error('Failed to send ops manager approval email', { error: emailErr.message, entryId: inspection.EntryId });
          }
        })();
      }
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/qa/summary — QA Report Summary for management ────
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const { dateFrom, dateTo, factory } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let dateFilter = '';
    if (dateFrom) { dateFilter += ' AND qi.InspectionDate >= @dateFrom'; request.input('dateFrom', sql.Date, dateFrom); }
    if (dateTo) { dateFilter += ' AND qi.InspectionDate < DATEADD(day, 1, @dateTo)'; request.input('dateTo', sql.Date, dateTo); }

    let factoryFilter = '';
    if (factory) {
      factoryFilter = ' AND ISNULL(sl.LocationName, \'\') = @factory';
      request.input('factory', sql.NVarChar(100), factory);
    }

    // Stats — always LEFT JOIN GRN+Location so factory filter works
    const statsResult = await request.query(`
      SELECT
        COUNT(*) AS TotalInspections,
        SUM(CASE WHEN qi.OverallStatus = 'Accepted' THEN 1 ELSE 0 END) AS Accepted,
        SUM(CASE WHEN qi.OverallStatus = 'Rejected' THEN 1 ELSE 0 END) AS Rejected,
        SUM(CASE WHEN qi.OverallStatus = 'Quarantine' THEN 1 ELSE 0 END) AS Quarantine,
        SUM(CASE WHEN qi.OverallStatus = 'Conditional' THEN 1 ELSE 0 END) AS Conditional,
        SUM(CASE WHEN qi.OverallStatus IN ('Pending', 'InProgress') THEN 1 ELSE 0 END) AS InProgress,
        ISNULL(SUM(qi.AcceptedQty), 0) AS TotalAcceptedQty,
        ISNULL(SUM(qi.RejectedQty), 0) AS TotalRejectedQty
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
      WHERE 1=1 ${dateFilter} ${factoryFilter}
    `);

    // Recent finalized inspections — always LEFT JOIN for Factory column
    const request2 = pool.request();
    if (dateFrom) request2.input('dateFrom', sql.Date, dateFrom);
    if (dateTo) request2.input('dateTo', sql.Date, dateTo);
    let factoryFilter2 = '';
    if (factory) {
      factoryFilter2 = ' AND ISNULL(sl2.LocationName, \'\') = @factory';
      request2.input('factory', sql.NVarChar(100), factory);
    }
    const recentResult = await request2.query(`
      SELECT qi.InspectionNo, qi.OverallStatus, qi.InspectionDate, qi.ApprovedAt,
             qi.AcceptedQty, qi.RejectedQty, qi.OverallRemarks,
             de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.NetWeight,
             s.SupplierName, u.FullName AS InspectorName, ua.FullName AS ApprovedByName,
             sl2.LocationName AS Factory,
             (SELECT STRING_AGG(m.MaterialName, ', ') FROM dbo.DeliveryEntryItems dei
              JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
              WHERE dei.EntryId = de.EntryId) AS Materials
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      JOIN dbo.Users u ON u.UserId = qi.InspectorId
      LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
      LEFT JOIN dbo.GoodsReceiptNotes grn2 ON grn2.EntryId = de.EntryId
      LEFT JOIN dbo.StockLocations sl2 ON sl2.LocationId = grn2.LocationId
      WHERE qi.OverallStatus IN ('Accepted', 'Rejected', 'Quarantine', 'Conditional')
      ${dateFilter} ${factoryFilter2}
      ORDER BY qi.ApprovedAt DESC
    `);

    // Fetch factory locations for dropdown
    const locResult = await pool.request().query(
      "SELECT LocationName FROM dbo.StockLocations WHERE IsActive = 1 ORDER BY LocationName"
    );

    res.json({
      stats: statsResult.recordset[0],
      inspections: recentResult.recordset,
      factories: locResult.recordset.map(r => r.LocationName),
    });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/qa/pending — Entries awaiting QA ────
// Factory filter (2026-07-31): users who canSeeAllFactories (Admin,
// Supervisor, QAManager) can now optionally narrow this list with
// ?factory=<LocationName> — driven by a dropdown on the frontend so they
// don't have to scroll through every factory's rows at once. Factory-
// restricted users are unaffected: their existing auto-filter (derived
// from their f<N>production@ email) still applies exactly as before, and
// this query param is ignored for them — they can't use it to see outside
// their own factory.
//
// Filter now visible to everyone (2026-08-19): the dropdown itself shows
// for all users, but the security behavior is unchanged — a user whose
// email auto-detects a factory (f<N>production@...) still stays locked
// to that factory server-side no matter what they pick in the UI. Only
// users with NEITHER a canSeeAllFactories role NOR an auto-detected
// factory (e.g. a QAInspector without an f<N>production@ email) now get
// to actually use the manual filter, since previously they had no way at
// all to narrow the list down.
router.get('/pending', authenticate, async (req, res, next) => {
  try {
    const { factory } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let factoryFilter = '';
    if (!canSeeAllFactories(req.user.role)) {
      const factoryId = extractFactoryFromEmail(req.user.email);
      if (factoryId) {
        factoryFilter = ' AND sl.LocationName LIKE @factoryPattern';
        request.input('factoryPattern', sql.NVarChar(100), `%${factoryId}%`);
      } else if (factory) {
        // No auto-detected factory restriction for this user (their email
        // doesn't match the f<N>production@ pattern) — honor their manual
        // filter selection the same way a canSeeAllFactories user would.
        factoryFilter = ' AND sl.LocationName = @factory';
        request.input('factory', sql.NVarChar(100), factory);
      }
    } else if (factory) {
      factoryFilter = ' AND sl.LocationName = @factory';
      request.input('factory', sql.NVarChar(100), factory);
    }

    const result = await request
      .query(`SELECT de.EntryId, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.NetWeight, de.Status,
                     de.DeliveryDate, de.DeliveryTime, de.CreatedAt AS GateEntryAt,
                     de.PurchaseOrderNo, de.LocationId,
                     s.SupplierName, s.SupplierCode,
                     qi.InspectionId, qi.InspectionNo, qi.OverallStatus AS QAStatus,
                     sl.LocationName AS FactoryName,
                     wr.CreatedAt AS WBCompletedAt
              FROM dbo.DeliveryEntries de
              JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
              LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = (
                -- An entry sent back by the Ops Manager for re-inspection
                -- can have more than one QAInspections row (the old
                -- rejected one, plus a fresh one once QA restarts it).
                -- Deliberately excludes OverallStatus = 'Rejected' — the
                -- frontend uses qi.InspectionNo being present/absent to
                -- decide whether its button reads "Continue" (open the
                -- existing draft) or "Inspect" (start a new one). If this
                -- picked the old rejected row, QA would land on a
                -- finalized inspection they can no longer edit
                -- (qa.routes.js's own PATCH /:inspectionNo/decision
                -- guard blocks writes to a finalized OverallStatus)
                -- instead of starting the fresh inspection they need.
                SELECT TOP 1 qi2.InspectionId FROM dbo.QAInspections qi2
                WHERE qi2.EntryId = de.EntryId AND qi2.OverallStatus NOT IN ('Rejected')
                ORDER BY qi2.InspectionId DESC
              )
              LEFT JOIN dbo.StockLocations sl ON sl.LocationId = de.LocationId
              LEFT JOIN (SELECT EntryId, MAX(CreatedAt) AS CreatedAt FROM dbo.WeighbridgeRecords GROUP BY EntryId) wr ON wr.EntryId = de.EntryId
              WHERE de.Status IN ('WeighbridgeCompleted', 'QAPending', 'Quarantine')
              ${factoryFilter}
              ORDER BY de.CreatedAt ASC`);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/qa — List inspections ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = '1=1';
    if (status) { where += ' AND qi.OverallStatus = @status'; request.input('status', sql.VarChar(20), status); }
    if (search) {
      where += ' AND (qi.InspectionNo LIKE @search OR de.EntryNo LIKE @search OR s.SupplierName LIKE @search)';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT qi.*, de.EntryNo, de.ConsignmentNo, s.SupplierName, u.FullName AS InspectorName,
             ua.FullName AS ApprovedByName
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      JOIN dbo.Users u ON u.UserId = qi.InspectorId
      LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
      WHERE ${where}
      ORDER BY qi.InspectionDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);

    res.json({ data: result.recordset, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════════
// QA TEST TEMPLATES — Configurable test parameters per factory per material
// Must be before /:inspectionNo to avoid route conflict
// ════════════════════════════════════════════════════════════════

// ──── GET /api/qa/templates — List templates for a factory+material ────
router.get('/templates', authenticate, async (req, res, next) => {
  try {
    const { locationId, materialId } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = 'qt.IsActive = 1';
    if (locationId) {
      where += ' AND qt.LocationId = @locationId';
      request.input('locationId', sql.Int, parseInt(locationId));
    }
    if (materialId) {
      where += ' AND qt.MaterialId = @materialId';
      request.input('materialId', sql.Int, parseInt(materialId));
    }

    const result = await request.query(`
      SELECT qt.*, sl.LocationName, m.MaterialCode, m.MaterialName
      FROM dbo.QATestTemplates qt
      JOIN dbo.StockLocations sl ON sl.LocationId = qt.LocationId
      JOIN dbo.Materials m ON m.MaterialId = qt.MaterialId
      WHERE ${where}
      ORDER BY sl.LocationName, m.MaterialName, qt.SortOrder, qt.TestName
    `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/qa/templates/for-inspection — Get templates for a specific entry (auto-match factory+materials) ────
router.get('/templates/for-inspection', authenticate, async (req, res, next) => {
  try {
    const { entryNo } = req.query;
    if (!entryNo) return res.status(400).json({ error: 'entryNo is required' });

    const pool = await getPool();

    // Get entry's locationId and materials
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query(`SELECT de.EntryId, de.LocationId
              FROM dbo.DeliveryEntries de WHERE de.EntryNo = @entryNo`);

    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    if (!entry.LocationId) return res.json([]);

    // Find templates matching the entry's location and materials
    const result = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .input('locationId', sql.Int, entry.LocationId)
      .query(`SELECT qt.TemplateId, qt.TestName, qt.TestMethod, qt.ExpectedValue, qt.SortOrder,
                     m.MaterialId, m.MaterialCode, m.MaterialName
              FROM dbo.QATestTemplates qt
              JOIN dbo.Materials m ON m.MaterialId = qt.MaterialId
              WHERE qt.LocationId = @locationId
                AND qt.IsActive = 1
                AND qt.MaterialId IN (SELECT dei.MaterialId FROM dbo.DeliveryEntryItems dei WHERE dei.EntryId = @entryId)
              ORDER BY m.MaterialName, qt.SortOrder, qt.TestName`);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

// ──── POST /api/qa/templates — Create a test template ────
router.post('/templates', authenticate, authorize('QAInspector', 'QAManager', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const { locationId, materialId, testName, testMethod, expectedValue, sortOrder } = req.body;
    if (!locationId || !materialId || !testName) {
      return res.status(400).json({ error: 'locationId, materialId, and testName are required' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('locationId', sql.Int, locationId)
      .input('materialId', sql.Int, materialId)
      .input('testName', sql.NVarChar(100), testName)
      .input('testMethod', sql.NVarChar(200), testMethod || null)
      .input('expectedValue', sql.NVarChar(100), expectedValue || null)
      .input('sortOrder', sql.Int, sortOrder || 0)
      .input('createdBy', sql.Int, req.user.userId)
      .query(`INSERT INTO dbo.QATestTemplates (LocationId, MaterialId, TestName, TestMethod, ExpectedValue, SortOrder, CreatedBy)
              OUTPUT INSERTED.*
              VALUES (@locationId, @materialId, @testName, @testMethod, @expectedValue, @sortOrder, @createdBy)`);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// ──── PUT /api/qa/templates/:id — Update a test template ────
router.put('/templates/:id', authenticate, authorize('QAInspector', 'QAManager', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const templateId = parseInt(req.params.id);
    const { testName, testMethod, expectedValue, sortOrder, isActive } = req.body;

    const pool = await getPool();
    const result = await pool.request()
      .input('templateId', sql.Int, templateId)
      .input('testName', sql.NVarChar(100), testName)
      .input('testMethod', sql.NVarChar(200), testMethod || null)
      .input('expectedValue', sql.NVarChar(100), expectedValue || null)
      .input('sortOrder', sql.Int, sortOrder || 0)
      .input('isActive', sql.Bit, isActive !== false ? 1 : 0)
      .query(`UPDATE dbo.QATestTemplates
              SET TestName = @testName, TestMethod = @testMethod, ExpectedValue = @expectedValue,
                  SortOrder = @sortOrder, IsActive = @isActive, UpdatedAt = GETUTCDATE()
              WHERE TemplateId = @templateId`);

    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ message: 'Template updated' });
  } catch (err) {
    next(err);
  }
});

// ──── DELETE /api/qa/templates/:id — Delete a test template ────
router.delete('/templates/:id', authenticate, authorize('QAInspector', 'QAManager', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('templateId', sql.Int, parseInt(req.params.id))
      .query('DELETE FROM dbo.QATestTemplates WHERE TemplateId = @templateId');

    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ message: 'Template deleted' });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/qa/:inspectionNo — Get inspection detail ────
router.get('/:inspectionNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('inspNo', sql.VarChar(20), req.params.inspectionNo)
      .query(`SELECT qi.*, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.PurchaseOrderNo,
                     s.SupplierName, s.SupplierCode, u.FullName AS InspectorName, ua.FullName AS ApprovedByName
              FROM dbo.QAInspections qi
              JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
              JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
              JOIN dbo.Users u ON u.UserId = qi.InspectorId
              LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
              WHERE qi.InspectionNo = @inspNo`);
    if (!result.recordset[0]) return res.status(404).json({ error: 'Inspection not found' });

    const inspection = result.recordset[0];

    // Fetch test results
    const tests = await pool.request()
      .input('inspId', sql.Int, inspection.InspectionId)
      .query(`SELECT tr.*, m.MaterialCode, m.MaterialName, u.FullName AS TestedByName
              FROM dbo.QATestResults tr
              JOIN dbo.Materials m ON m.MaterialId = tr.MaterialId
              JOIN dbo.Users u ON u.UserId = tr.TestedBy
              WHERE tr.InspectionId = @inspId ORDER BY tr.TestedAt`);

    // Fetch entry items for material context
    const items = await pool.request()
      .input('entryId', sql.Int, inspection.EntryId)
      .query(`SELECT dei.*, m.MaterialCode, m.MaterialName FROM dbo.DeliveryEntryItems dei
              JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId WHERE dei.EntryId = @entryId`);

    res.json({ ...inspection, tests: tests.recordset, entryItems: items.recordset });
  } catch (err) {
    next(err);
  }
});

// ──── DELETE /api/qa/:inspectionNo — Delete QA inspection (Admin only) ────
router.delete('/:inspectionNo', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('inspNo', sql.VarChar(20), req.params.inspectionNo)
      .query(`SELECT qi.InspectionId, qi.EntryId, qi.OverallStatus, de.Status AS EntryStatus, de.VersionNo
              FROM dbo.QAInspections qi
              JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
              WHERE qi.InspectionNo = @inspNo`);

    if (!result.recordset[0]) return res.status(404).json({ error: 'Inspection not found' });
    const insp = result.recordset[0];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // 1. Delete GoodsRejectionItems via GoodsRejectionNotes linked to this inspection
      await new sql.Request(transaction)
        .input('inspId', sql.Int, insp.InspectionId)
        .query(`DELETE FROM dbo.GoodsRejectionItems
                WHERE RejectionId IN (SELECT RejectionId FROM dbo.GoodsRejectionNotes WHERE InspectionId = @inspId)`);

      // 2. Delete GoodsRejectionNotes linked to this inspection
      await new sql.Request(transaction)
        .input('inspId', sql.Int, insp.InspectionId)
        .query('DELETE FROM dbo.GoodsRejectionNotes WHERE InspectionId = @inspId');

      // 3. Delete QATestResults
      await new sql.Request(transaction)
        .input('inspId', sql.Int, insp.InspectionId)
        .query('DELETE FROM dbo.QATestResults WHERE InspectionId = @inspId');

      // 4. Delete QAInspection
      await new sql.Request(transaction)
        .input('inspId', sql.Int, insp.InspectionId)
        .query('DELETE FROM dbo.QAInspections WHERE InspectionId = @inspId');

      // 5. Reset entry status back to WeighbridgeCompleted so it can be re-inspected
      await new sql.Request(transaction)
        .input('entryId', sql.Int, insp.EntryId)
        .query(`UPDATE dbo.DeliveryEntries SET Status = 'WeighbridgeCompleted', VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'QAInspection', entityId: insp.InspectionId, action: 'Delete',
        userId: req.user.userId, newValues: { inspectionNo: req.params.inspectionNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });

      res.json({ message: 'QA inspection deleted', inspectionNo: req.params.inspectionNo });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;