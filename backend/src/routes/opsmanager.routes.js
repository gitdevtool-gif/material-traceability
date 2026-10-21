const express = require('express');
const crypto = require('crypto');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');
const { sendOpsApprovalEmail } = require('../services/email.service');
const config = require('../config');

const router = express.Router();

// An entry can now go through more than one QA inspection cycle — Ops
// Manager rejecting one sends it back to QA for a fresh inspection (see
// PATCH /:entryNo and GET /token/:token below), so dbo.QAInspections is
// no longer guaranteed 1 row per EntryId. Every query in this file that
// needs "the inspection relevant to this entry right now" joins through
// this subquery (latest InspectionId per EntryId) instead of a plain
// EntryId join, which would otherwise return duplicate/wrong rows for
// any entry that's been through re-inspection.
const LATEST_INSPECTION_JOIN = `(
        SELECT TOP 1 qi2.InspectionId FROM dbo.QAInspections qi2
        WHERE qi2.EntryId = de.EntryId ORDER BY qi2.InspectionId DESC
      )`;

// ──── GET /api/ops-approval — List entries awaiting Ops Manager approval ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query(`
        SELECT de.EntryId, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo,
               de.PurchaseOrderNo, de.DeliveryDate, de.DeliveryTime, de.CreatedAt AS GateEntryAt,
               de.Status,
               s.SupplierName,
               qi.InspectionNo, qi.OverallStatus AS QADecision,
               qi.AcceptedQty, qi.RejectedQty, qi.OverallRemarks AS QARemarks,
               qi.InspectionDate, qi.ApprovedAt AS QADecisionAt,
               u.FullName AS InspectorName,
               approver.FullName AS QAApproverName,
               wr.NetWeight AS WBNetWeight
        FROM dbo.DeliveryEntries de
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = ${LATEST_INSPECTION_JOIN}
        LEFT JOIN dbo.Users u ON u.UserId = qi.InspectorId
        LEFT JOIN dbo.Users approver ON approver.UserId = qi.ApprovedBy
        LEFT JOIN (SELECT EntryId, SUM(NetWeight) AS NetWeight FROM dbo.WeighbridgeRecords GROUP BY EntryId) wr ON wr.EntryId = de.EntryId
        WHERE de.Status = 'QAAccepted'
        ORDER BY qi.InspectionDate DESC
      `);
    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/ops-approval/token/:token — Email-based approve/reject (no login required) ────
router.get('/token/:token', async (req, res) => {
  try {
    const { action } = req.query; // ?action=approve or ?action=reject
    if (!action || !['approve', 'reject'].includes(action)) {
      return res.send(renderResultPage('error', 'Invalid Action', 'The approval link is invalid. Please contact the system administrator.'));
    }

    const pool = await getPool();
    const tokenResult = await pool.request()
      .input('token', sql.VarChar(100), req.params.token)
      .query('SELECT * FROM dbo.ApprovalTokens WHERE Token = @token');

    if (!tokenResult.recordset[0]) {
      return res.send(renderResultPage('error', 'Invalid Link', 'This approval link is not valid or has already been used.'));
    }

    const tokenRec = tokenResult.recordset[0];

    if (tokenRec.IsUsed) {
      return res.send(renderResultPage('warning', 'Already Processed', `This entry (${tokenRec.EntryNo}) has already been ${tokenRec.Action || 'processed'}. No further action needed.`));
    }

    if (new Date() > new Date(tokenRec.ExpiresAt)) {
      return res.send(renderResultPage('error', 'Link Expired', 'This approval link has expired. Please log in to the system to review the entry.'));
    }

    // Check entry is still awaiting approval, and find the inspection
    // this decision actually applies to (the latest one — see
    // LATEST_INSPECTION_JOIN docstring at the top of this file).
    const entryResult = await pool.request()
      .input('entryId', sql.Int, tokenRec.EntryId)
      .query(`
        SELECT de.EntryId, de.Status, de.VersionNo, qi.InspectionId
        FROM dbo.DeliveryEntries de
        LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = ${LATEST_INSPECTION_JOIN}
        WHERE de.EntryId = @entryId
      `);

    if (!entryResult.recordset[0]) {
      return res.send(renderResultPage('error', 'Entry Not Found', 'The delivery entry could not be found.'));
    }

    const entry = entryResult.recordset[0];
    if (entry.Status !== 'QAAccepted') {
      return res.send(renderResultPage('warning', 'Already Processed', `Entry ${tokenRec.EntryNo} status is "${entry.Status}". It has already been processed.`));
    }

    const decision = action === 'approve' ? 'Approved' : 'Rejected';
    // Rejecting via email sends the entry back to QA for re-inspection,
    // same as the in-app Reject button — never a dead end. See the
    // PATCH /:entryNo handler above for the full rationale.
    const newStatus = action === 'approve' ? 'OpsManagerApproved' : 'QAPending';

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // Update QA inspection with ops manager decision — scoped to the
      // specific inspection row found above, not every row on this
      // EntryId (an entry can have more than one after a re-inspection
      // cycle).
      if (entry.InspectionId) {
        await new sql.Request(transaction)
          .input('inspId', sql.Int, entry.InspectionId)
          .input('decision', sql.VarChar(20), decision)
          .input('remarks', sql.NVarChar(1000), `${decision} via email`)
          .query(`UPDATE dbo.QAInspections
                  SET OpsManagerDecision = @decision,
                      OpsManagerApprovedAt = GETUTCDATE(),
                      OpsManagerRemarks = @remarks,
                      OverallStatus = CASE WHEN @decision = 'Rejected' THEN 'Rejected' ELSE OverallStatus END,
                      VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                  WHERE InspectionId = @inspId`);
      }

      // Update entry status
      await new sql.Request(transaction)
        .input('entryId', sql.Int, tokenRec.EntryId)
        .input('status', sql.VarChar(30), newStatus)
        .query(`UPDATE dbo.DeliveryEntries SET Status = @status, VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      // Mark token as used
      await new sql.Request(transaction)
        .input('token', sql.VarChar(100), req.params.token)
        .input('action', sql.VarChar(10), decision)
        .query(`UPDATE dbo.ApprovalTokens SET IsUsed = 1, Action = @action, UsedAt = GETUTCDATE() WHERE Token = @token`);

      // Also mark the other token for this entry as used (prevent double-action)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, tokenRec.EntryId)
        .input('token', sql.VarChar(100), req.params.token)
        .query(`UPDATE dbo.ApprovalTokens SET IsUsed = 1, UsedAt = GETUTCDATE() WHERE EntryId = @entryId AND Token != @token AND IsUsed = 0`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'OpsManagerApproval', entityId: tokenRec.EntryId, action: 'StatusChange',
        userId: 0, oldValues: { status: 'QAAccepted' },
        newValues: { status: newStatus, decision, method: 'email' },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: tokenRec.EntryId,
        fromStatus: 'QAAccepted', toStatus: newStatus, changedBy: 0,
        remarks: decision === 'Rejected'
          ? 'Ops Manager rejected via email link — sent back to QA for re-inspection'
          : 'Ops Manager approved via email link',
      });

      if (action === 'approve') {
        return res.send(renderResultPage('success', 'Approved ✅', `Entry <strong>${tokenRec.EntryNo}</strong> has been approved. It will now proceed to Receiving for GRN creation.`));
      } else {
        return res.send(renderResultPage('rejected', 'Sent back to QA ↩️', `Entry <strong>${tokenRec.EntryNo}</strong> has been rejected and sent back to QA for a fresh inspection. The QA team will be notified.`));
      }
    } catch (err) {
      await transaction.rollback();
      return res.send(renderResultPage('error', 'Error', 'An error occurred while processing. Please try again or log in to the system.'));
    }
  } catch (err) {
    return res.send(renderResultPage('error', 'Error', 'An unexpected error occurred. Please contact the system administrator.'));
  }
});

// ──── GET /api/ops-approval/:entryNo — Get full entry detail for review ────
router.get('/:entryNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query(`
        SELECT de.*, s.SupplierName, s.SupplierCode,
               qi.InspectionId, qi.InspectionNo, qi.OverallStatus AS QADecision,
               qi.AcceptedQty, qi.RejectedQty, qi.OverallRemarks AS QARemarks,
               qi.COAProvided, qi.COAReference, qi.SamplesTaken, qi.PhysicalCheckDone,
               qi.VehicleInspectionDone, qi.InspectionDate,
               inspector.FullName AS InspectorName,
               approver.FullName AS QAApproverName,
               wr.NetWeight AS WBNetWeight, wr.FirstWeight AS WBFirstWeight,
               wr.SecondWeight AS WBSecondWeight, wr.WeightVariance
        FROM dbo.DeliveryEntries de
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = ${LATEST_INSPECTION_JOIN}
        LEFT JOIN dbo.Users inspector ON inspector.UserId = qi.InspectorId
        LEFT JOIN dbo.Users approver ON approver.UserId = qi.ApprovedBy
        LEFT JOIN dbo.WeighbridgeRecords wr ON wr.EntryId = de.EntryId
        WHERE de.EntryNo = @entryNo
      `);

    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    // Get materials
    const items = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query(`SELECT dei.*, m.MaterialCode, m.MaterialName
              FROM dbo.DeliveryEntryItems dei
              JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
              WHERE dei.EntryId = @entryId`);

    // Get QA test results
    let testResults = [];
    if (entry.InspectionId) {
      const tests = await pool.request()
        .input('inspId', sql.Int, entry.InspectionId)
        .query(`SELECT tr.*, m.MaterialName
                FROM dbo.QATestResults tr
                JOIN dbo.Materials m ON m.MaterialId = tr.MaterialId
                WHERE tr.InspectionId = @inspId`);
      testResults = tests.recordset;
    }

    res.json({ ...entry, items: items.recordset, testResults });
  } catch (err) {
    next(err);
  }
});

// ──── PATCH /api/ops-approval/:entryNo — Approve, or Reject back to QA ────
// Rejecting here is NOT a dead end (that's what a Goods Rejection Note is
// for, via /api/rejections). It sends the entry back into QA's own queue
// for a fresh inspection: DeliveryEntries.Status -> 'QAPending' (the same
// status QA's own "start inspection" flow already accepts), and the
// current QAInspections row's OverallStatus -> 'Rejected' so it stops
// counting as the entry's "active" inspection (see qa.routes.js POST /'s
// guard) and QA can open a brand new one. See LATEST_INSPECTION_JOIN at
// the top of this file for how every other query here now finds the
// right (most recent) inspection row once an entry can have more than one.
router.patch('/:entryNo', authenticate, authorize('OpsManager', 'Supervisor', 'Director', 'Admin'), async (req, res, next) => {
  try {
    const { decision, acceptedQty, rejectedQty, remarks } = req.body;
    if (!decision || !['Approved', 'Rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approved or Rejected' });
    }
    if (decision === 'Rejected' && !remarks?.trim()) {
      return res.status(400).json({ error: 'Remarks are required when rejecting — QA will see this when they re-inspect' });
    }

    const pool = await getPool();
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query(`SELECT de.EntryId, de.Status, de.VersionNo,
                     qi.InspectionId, qi.AcceptedQty, qi.RejectedQty, qi.VersionNo AS QAVersionNo
              FROM dbo.DeliveryEntries de
              LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = ${LATEST_INSPECTION_JOIN}
              WHERE de.EntryNo = @entryNo`);

    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    if (entry.Status !== 'QAAccepted') {
      return res.status(400).json({ error: `Entry status is ${entry.Status}. Must be QAAccepted for Ops Manager review.` });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // Update QA Inspection with Ops Manager review. On rejection, also
      // flip OverallStatus to 'Rejected' — this is what frees up
      // qa.routes.js POST /'s "no active inspection" guard so QA can open
      // a brand new inspection on this entry instead of being permanently
      // blocked by the old (now-superseded) row.
      if (entry.InspectionId) {
        const updReq = new sql.Request(transaction);
        await updReq
          .input('inspId', sql.Int, entry.InspectionId)
          .input('opsManagerId', sql.Int, req.user.userId)
          .input('opsDecision', sql.VarChar(20), decision)
          .input('opsRemarks', sql.NVarChar(1000), remarks || null)
          .input('acceptedQty', sql.Decimal(12, 2), acceptedQty != null ? acceptedQty : null)
          .input('rejectedQty', sql.Decimal(12, 2), rejectedQty != null ? rejectedQty : null)
          .query(`UPDATE dbo.QAInspections
                  SET OpsManagerId = @opsManagerId,
                      OpsManagerDecision = @opsDecision,
                      OpsManagerRemarks = @opsRemarks,
                      OpsManagerApprovedAt = GETUTCDATE(),
                      AcceptedQty = COALESCE(@acceptedQty, AcceptedQty),
                      RejectedQty = COALESCE(@rejectedQty, RejectedQty),
                      OverallStatus = CASE WHEN @opsDecision = 'Rejected' THEN 'Rejected' ELSE OverallStatus END,
                      VersionNo = VersionNo + 1,
                      UpdatedAt = GETUTCDATE()
                  WHERE InspectionId = @inspId`);
      }

      // Update entry status — Approved proceeds to Receiving as before;
      // Rejected goes back to QAPending so it re-enters QA's own pending
      // queue (qa.routes.js GET /pending) for a fresh inspection, instead
      // of dead-ending.
      const newStatus = decision === 'Approved' ? 'OpsManagerApproved' : 'QAPending';
      const entryReq = new sql.Request(transaction);
      await entryReq
        .input('entryId', sql.Int, entry.EntryId)
        .input('status', sql.VarChar(30), newStatus)
        .query(`UPDATE dbo.DeliveryEntries
                SET Status = @status, VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'OpsManagerApproval', entityId: entry.EntryId, action: 'StatusChange',
        userId: req.user.userId,
        oldValues: { status: 'QAAccepted', acceptedQty: entry.AcceptedQty, rejectedQty: entry.RejectedQty },
        newValues: { status: newStatus, decision, acceptedQty, rejectedQty, remarks },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: 'QAAccepted', toStatus: newStatus, changedBy: req.user.userId,
        remarks: decision === 'Rejected'
          ? `Ops Manager rejected — sent back to QA for re-inspection. ${remarks}`
          : `Ops Manager approved. ${remarks || ''}`,
      });

      res.json({
        message: decision === 'Approved'
          ? 'Entry approved by Ops Manager'
          : 'Entry rejected — sent back to QA for re-inspection',
        status: newStatus,
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── POST /api/ops-approval/send-email/:entryNo — Send approval email (called after QA acceptance) ────
router.post('/send-email/:entryNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query(`
        SELECT de.EntryId, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.Status,
               s.SupplierName,
               qi.AcceptedQty, qi.RejectedQty, qi.OverallStatus AS QADecision,
               qi.OverallRemarks AS QARemarks,
               inspector.FullName AS InspectorName
        FROM dbo.DeliveryEntries de
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = ${LATEST_INSPECTION_JOIN}
        LEFT JOIN dbo.Users inspector ON inspector.UserId = qi.InspectorId
        WHERE de.EntryNo = @entryNo
      `);
    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    // Get material names
    const items = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query('SELECT m.MaterialName FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId WHERE dei.EntryId = @entryId');
    const materialNames = items.recordset.map(i => i.MaterialName).join(', ');

    // Fetch weighbridge ticket numbers
    const wbTickets = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query('SELECT TicketNo FROM dbo.WeighbridgeRecords WHERE EntryId = @entryId AND TicketNo IS NOT NULL');
    const ticketNos = wbTickets.recordset.length > 0
      ? wbTickets.recordset.map(r => r.TicketNo).join(', ')
      : null;

    // Generate two tokens: one for approve, one for reject
    const approveToken = crypto.randomBytes(32).toString('hex');
    const rejectToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

    await pool.request()
      .input('token', sql.VarChar(100), approveToken)
      .input('entryId', sql.Int, entry.EntryId)
      .input('entryNo', sql.VarChar(20), entry.EntryNo)
      .input('expiresAt', sql.DateTime2, expiresAt)
      .query('INSERT INTO dbo.ApprovalTokens (Token, EntryId, EntryNo, ExpiresAt) VALUES (@token, @entryId, @entryNo, @expiresAt)');

    await pool.request()
      .input('token', sql.VarChar(100), rejectToken)
      .input('entryId', sql.Int, entry.EntryId)
      .input('entryNo', sql.VarChar(20), entry.EntryNo)
      .input('expiresAt', sql.DateTime2, expiresAt)
      .query('INSERT INTO dbo.ApprovalTokens (Token, EntryId, EntryNo, ExpiresAt) VALUES (@token, @entryId, @entryNo, @expiresAt)');

    // Send email
    const sent = await sendOpsApprovalEmail({
      to: config.email.opsManagerEmail,
      entryNo: entry.EntryNo,
      supplierName: entry.SupplierName,
      consignmentNo: entry.ConsignmentNo,
      vehicleRegNo: entry.VehicleRegNo,
      materialNames,
      ticketNos,
      acceptedQty: entry.AcceptedQty,
      rejectedQty: entry.RejectedQty,
      qaDecision: entry.QADecision,
      qaRemarks: entry.QARemarks,
      inspectorName: entry.InspectorName,
      approveToken,
      rejectToken,
    });

    res.json({ sent, message: sent ? 'Approval email sent' : 'Failed to send email' });
  } catch (err) {
    next(err);
  }
});

// Helper: render a nice HTML result page for email approvals
function renderResultPage(type, title, message) {
  const colors = {
    success: { bg: '#f0fdf4', border: '#86efac', icon: '✅', text: '#166534' },
    rejected: { bg: '#fef2f2', border: '#fca5a5', icon: '❌', text: '#991b1b' },
    warning: { bg: '#fffbeb', border: '#fde68a', icon: '⚠️', text: '#92400e' },
    error: { bg: '#fef2f2', border: '#fca5a5', icon: '⚠️', text: '#991b1b' },
  };
  const c = colors[type] || colors.error;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Njoro Canning Factory</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f4f5;display:flex;justify-content:center;align-items:center;min-height:100vh;">
  <div style="background:#fff;border-radius:12px;padding:40px;max-width:500px;width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="font-size:48px;margin-bottom:16px;">${c.icon}</div>
    <h1 style="font-size:24px;color:${c.text};margin:0 0 12px;">${title}</h1>
    <div style="background:${c.bg};border:1px solid ${c.border};border-radius:8px;padding:16px;margin-bottom:20px;">
      <p style="margin:0;font-size:15px;color:#333;">${message}</p>
    </div>
    <p style="font-size:12px;color:#9ca3af;">Njoro Canning Factory — Material Traceability System</p>
  </div>
</body></html>`;
}

module.exports = router;
