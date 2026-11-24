/**
 * Requisition Ops-Approval Routes
 *
 * Gate between the Busy sync (procurement-sync.service.js) and
 * Procurement's existing RFQ dispatch flow. Every requisition synced
 * from Busy lands here first (Status = 'PendingOpsApproval'), invisible
 * to Procurement. An Ops Manager reviews each line item next to its
 * current stock picture (dbo.ReorderStatus, matched by ItemName) and
 * Approves (-> 'Pending', enters requisitions.routes.js's existing flow
 * unchanged) or Rejects (-> 'RejectedByOps', dead-ends).
 *
 * Stock match: LEFT JOIN on ItemName (trimmed, case-insensitive) since
 * there's no shared foreign key between RequisitionItems and
 * ReorderStatus — same matching approach already used by
 * requisitions.routes.js's recategorize endpoint.
 *
 * See migration_021_requisition_ops_approval.sql for schema.
 */
const express = require('express');
const crypto = require('crypto');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../../services/audit.service');
const { sendRequisitionApprovalEmail } = require('../../services/email.service');
const { resolveCategoryForItemNames } = require('../../services/requisition-item-catalog.service');
const config = require('../../config');
const logger = require('../../logger');
const { GATE_DECIDER_ROLES, isWorkshopMatCenter, canDecideFor, gateScopeSql } = require('../../services/requisition-gate');

const router = express.Router();

const VIEW_ROLES = ['OpsManager', 'WorkshopHOD', 'Admin', 'Director'];
const DECIDE_ROLES = GATE_DECIDER_ROLES;
// FactoryReceiving clerks raise the Busy Purchase Indent that becomes a
// Requisition here — they can't decide anything, but need to check
// whether the Ops Manager has approved/rejected/held theirs, hence a
// wider read-only role list for the status-lookup endpoints below
// (GET /status, GET /:id) than the ones only the actual decision-makers
// use (GET /pending, the working queue; PATCH .../decision, .../hold).
// StoreReceiving added 2026-09-21 — Central Stores can now raise their own
// requisitions too (requisition-create.routes.js) and need the same
// read-only follow-up view a FactoryReceiving clerk already gets.
const STATUS_VIEW_ROLES = [...VIEW_ROLES, 'FactoryReceiving', 'FactoryQA', 'StoreReceiving'];

// ── Approve-all-items-at-full-qty, shared by the authenticated per-item
// decision endpoint's "everything approved" case and the email token
// route below (which has no logged-in user to run the full per-item form
// through). userId is null when triggered via email (see
// RequisitionApprovalTokens' schema note on that).
async function approveAllItemsForRequisition(pool, requisitionId, userId) {
  const itemsResult = await pool.request().input('id', sql.Int, requisitionId).query(
    'SELECT RequisitionItemId, Qty FROM dbo.RequisitionItems WHERE RequisitionId = @id'
  );
  const items = itemsResult.recordset;
  if (items.length === 0) throw Object.assign(new Error('Requisition has no items to approve'), { status: 400 });

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const idPlaceholders = items.map((_, i) => `@i${i}`).join(',');
    const delReq = new sql.Request(transaction);
    items.forEach((it, i) => delReq.input(`i${i}`, sql.Int, it.RequisitionItemId));
    await delReq.query(`DELETE FROM dbo.RequisitionItemApprovals WHERE RequisitionItemId IN (${idPlaceholders})`);

    for (const it of items) {
      await new sql.Request(transaction)
        .input('itemId', sql.Int, it.RequisitionItemId)
        .input('approvedQty', sql.Decimal(12, 2), it.Qty)
        .input('userId', sql.Int, userId)
        .query(`
          INSERT INTO dbo.RequisitionItemApprovals
            (RequisitionItemId, Decision, ApprovedQty, RejectionReason, DecidedByUserId)
          VALUES (@itemId, 'Approved', @approvedQty, NULL, @userId)
        `);
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, requisitionId)
      .input('userId', sql.Int, userId)
      .query(`
        UPDATE dbo.Requisitions
        SET Status = 'Pending',
            OpsApprovedByUserId = @userId,
            OpsApprovedAt = GETUTCDATE(),
            OpsRejectionReason = NULL,
            HoldReason = NULL, HoldByUserId = NULL, HoldAt = NULL
        WHERE RequisitionId = @id
      `);

    await transaction.commit();
  } catch (trxErr) {
    await transaction.rollback();
    throw trxErr;
  }
  return { status: 'Pending', approvedCount: items.length };
}

// ── Shared hold logic — see PATCH /:id/hold below for the authenticated
// entry point; the email token route reuses this with userId = null.
async function holdRequisitionInternal(pool, requisitionId, userId, reason) {
  await pool.request()
    .input('id', sql.Int, requisitionId)
    .input('userId', sql.Int, userId)
    .input('reason', sql.NVarChar(1000), reason || null)
    .query(`
      UPDATE dbo.Requisitions
      SET Status = 'OnHold', HoldReason = @reason, HoldByUserId = @userId, HoldAt = GETUTCDATE()
      WHERE RequisitionId = @id
    `);
}

// ── Sends the requisition ops-approval email and issues its two tokens
// (Approve All / Hold for Review). Called automatically right after a
// requisition syncs in as 'PendingOpsApproval' — see
// procurement-sync.service.js, which requires this module for it.
// Fire-and-forget from the caller's perspective (never throws out).
async function sendApprovalEmailForRequisition(requisitionId) {
  try {
    const pool = await getPool();
    const headerResult = await pool.request().input('id', sql.Int, requisitionId).query(
      'SELECT RequisitionId, BusyOrdNo, BusyDate, Warehouse, MatCenter FROM dbo.Requisitions WHERE RequisitionId = @id'
    );
    const header = headerResult.recordset[0];
    if (!header) return false;

    const itemsResult = await pool.request().input('id', sql.Int, requisitionId).query(
      'SELECT ItemName, Qty, Category FROM dbo.RequisitionItems WHERE RequisitionId = @id ORDER BY ItemName'
    );

    const approveToken = crypto.randomBytes(32).toString('hex');
    const holdToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h, same as the goods-receiving flow

    for (const token of [approveToken, holdToken]) {
      await pool.request()
        .input('token', sql.VarChar(100), token)
        .input('requisitionId', sql.Int, requisitionId)
        .input('busyOrdNo', sql.VarChar(50), header.BusyOrdNo)
        .input('expiresAt', sql.DateTime2, expiresAt)
        .query('INSERT INTO dbo.RequisitionApprovalTokens (Token, RequisitionId, BusyOrdNo, ExpiresAt) VALUES (@token, @requisitionId, @busyOrdNo, @expiresAt)');
    }

    const sent = await sendRequisitionApprovalEmail({
      to: isWorkshopMatCenter(header.MatCenter)
        ? config.email.requisitionWorkshopHodEmail
        : config.email.requisitionOpsManagerEmail,
      busyOrdNo: header.BusyOrdNo,
      warehouse: header.Warehouse,
      matCenter: header.MatCenter,
      busyDate: header.BusyDate,
      items: itemsResult.recordset,
      approveToken,
      holdToken,
    });
    return sent;
  } catch (err) {
    logger.error(`Failed to send requisition approval email for requisition ${requisitionId}:`, err);
    return false;
  }
}

// Helper: render a nice HTML result page for email approvals — same
// look as opsmanager.routes.js's renderResultPage, kept local here since
// it's a small, self-contained template rather than shared plumbing.
function renderResultPage(type, title, message) {
  const colors = {
    success: { bg: '#f0fdf4', border: '#86efac', icon: '✅', text: '#166534' },
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

// ── GET /api/procurement/requisition-approval/token/:token — Email-based
// Approve All / Hold, no login required. Mirrors opsmanager.routes.js's
// GET /token/:token but against RequisitionApprovalTokens/Requisitions
// instead of ApprovalTokens/DeliveryEntries. See sendApprovalEmailForRequisition
// above for why there's no one-click "reject" token.
router.get('/token/:token', async (req, res) => {
  try {
    const { action } = req.query; // ?action=approve or ?action=hold
    if (!action || !['approve', 'hold'].includes(action)) {
      return res.send(renderResultPage('error', 'Invalid Action', 'This approval link is invalid. Please contact the system administrator.'));
    }

    const pool = await getPool();
    const tokenResult = await pool.request()
      .input('token', sql.VarChar(100), req.params.token)
      .query('SELECT * FROM dbo.RequisitionApprovalTokens WHERE Token = @token');

    if (!tokenResult.recordset[0]) {
      return res.send(renderResultPage('error', 'Invalid Link', 'This approval link is not valid or has already been used.'));
    }
    const tokenRec = tokenResult.recordset[0];

    if (tokenRec.IsUsed) {
      return res.send(renderResultPage('warning', 'Already Processed', `Requisition ${tokenRec.BusyOrdNo} has already been ${tokenRec.Action || 'processed'}. No further action needed.`));
    }
    if (new Date() > new Date(tokenRec.ExpiresAt)) {
      return res.send(renderResultPage('error', 'Link Expired', 'This approval link has expired. Please log in to the system to review the requisition.'));
    }

    const current = await pool.request()
      .input('id', sql.Int, tokenRec.RequisitionId)
      .query('SELECT Status FROM dbo.Requisitions WHERE RequisitionId = @id');
    if (!current.recordset[0]) {
      return res.send(renderResultPage('error', 'Requisition Not Found', 'The requisition could not be found.'));
    }
    if (!['PendingOpsApproval', 'OnHold'].includes(current.recordset[0].Status)) {
      return res.send(renderResultPage('warning', 'Already Processed', `Requisition ${tokenRec.BusyOrdNo} status is "${current.recordset[0].Status}". It has already been processed.`));
    }

    try {
      if (action === 'approve') {
        await approveAllItemsForRequisition(pool, tokenRec.RequisitionId, null);
      } else {
        await holdRequisitionInternal(pool, tokenRec.RequisitionId, null, 'Held via email — awaiting manual review');
      }

      // Mark both tokens for this requisition used (prevent double-action).
      await pool.request()
        .input('reqId', sql.Int, tokenRec.RequisitionId)
        .input('token', sql.VarChar(100), req.params.token)
        .input('action', sql.VarChar(10), action)
        .query(`UPDATE dbo.RequisitionApprovalTokens SET IsUsed = 1, Action = @action, UsedAt = GETUTCDATE() WHERE Token = @token`);
      await pool.request()
        .input('reqId', sql.Int, tokenRec.RequisitionId)
        .input('token', sql.VarChar(100), req.params.token)
        .query(`UPDATE dbo.RequisitionApprovalTokens SET IsUsed = 1, UsedAt = GETUTCDATE() WHERE RequisitionId = @reqId AND Token != @token AND IsUsed = 0`);

      if (action === 'approve') {
        return res.send(renderResultPage('success', 'Approved ✅', `Requisition <strong>${tokenRec.BusyOrdNo}</strong> has been approved — every item at its full requested quantity. It is now visible to Procurement.`));
      }
      return res.send(renderResultPage('warning', 'On Hold ⏸', `Requisition <strong>${tokenRec.BusyOrdNo}</strong> has been put on hold. Log in to the system when you're ready to review and decide.`));
    } catch (err) {
      return res.send(renderResultPage('error', 'Error', 'An error occurred while processing. Please try again or log in to the system.'));
    }
  } catch (err) {
    return res.send(renderResultPage('error', 'Error', 'An unexpected error occurred. Please contact the system administrator.'));
  }
});

// ── GET /api/procurement/requisition-approval/pending ───────────────────────
// Includes both requisitions still awaiting a first decision, and ones
// the Ops Manager previously put 'OnHold' — held ones stay visible here
// (badged via Status) so they don't get lost, but never reach Procurement
// until actively approved/rejected.
// ?gate=workshop | ops narrows the queue to one gate for roles that see both
// (Director, Admin): the Workshop Approval page sends gate=workshop, the Ops
// Manager page gate=ops. The role's own scope always applies on top.
router.get('/pending', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const gate = String(req.query.gate || '').toLowerCase();
    const gateSql = gate === 'workshop' ? gateScopeSql('WorkshopHOD') : gate === 'ops' ? gateScopeSql('OpsManager') : '';
    const result = await pool.request().query(`
      SELECT
        r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter,
        r.Status, r.SyncedAt, r.CreatedAt, r.HoldReason, r.HoldAt,
        (SELECT COUNT(*) FROM dbo.RequisitionItems ri WHERE ri.RequisitionId = r.RequisitionId) AS ItemCount
      FROM dbo.Requisitions r
      WHERE r.Status IN ('PendingOpsApproval', 'OnHold')${gateScopeSql(req.user.role)}${gateSql}
      ORDER BY CASE r.Status WHEN 'PendingOpsApproval' THEN 0 ELSE 1 END, r.BusyDate ASC, r.BusyOrdNo ASC
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisition-approval/status ────────────────────────
// Read-only follow-up lookup — unlike GET /pending (which only lists
// PendingOpsApproval/OnHold, i.e. requisitions NOT yet resolved), this
// returns requisitions in ANY status so "did my indent get approved or
// rejected?" has an answer even after the Ops Manager has already acted.
// Built for FactoryReceiving clerks (who raise the Busy Purchase Indent
// this Requisition came from and have no other way to see what happened
// to it), but open to anyone in STATUS_VIEW_ROLES.
router.get('/status', authenticate, authorize(...STATUS_VIEW_ROLES), async (req, res, next) => {
  try {
    const { search, dateFrom, dateTo, status, page = 1, limit = 25 } = req.query;
    const pool = await getPool();

    let whereClause = '1=1';
    if (search)   whereClause += ' AND r.BusyOrdNo LIKE @search';
    if (dateFrom) whereClause += ' AND r.BusyDate >= @dateFrom';
    if (dateTo)   whereClause += ' AND r.BusyDate <= @dateTo';
    if (status)   whereClause += ' AND r.Status = @status';
    // A Workshop HOD only follows up on Workshop requisitions.
    if (req.user.role === 'WorkshopHOD') whereClause += gateScopeSql('WorkshopHOD');

    const bindParams = (request) => {
      if (search)   request.input('search', sql.VarChar(60), `%${search.trim()}%`);
      if (dateFrom) request.input('dateFrom', sql.Date, dateFrom);
      if (dateTo)   request.input('dateTo', sql.Date, dateTo);
      if (status)   request.input('status', sql.VarChar(30), status);
      return request;
    };

    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const dataReq = bindParams(pool.request());
    dataReq.input('offset', sql.Int, offset).input('limit', sql.Int, parseInt(limit, 10));
    const countReq = bindParams(pool.request());

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.Requisitions r WHERE ${whereClause}`),
      dataReq.query(`
        SELECT
          r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter, r.Status,
          r.OpsApprovedAt, r.OpsRejectionReason, r.OpsNotes,
          r.HoldReason, r.HoldAt,
          r.CentralStoresApprovedAt, r.CentralStoresRejectionReason, r.CentralStoresNotes,
          u.FullName AS OpsApprovedByName, hu.FullName AS HoldByName, cs.FullName AS CentralStoresApprovedByName,
          (SELECT COUNT(*) FROM dbo.RequisitionItems ri WHERE ri.RequisitionId = r.RequisitionId) AS ItemCount,
          (SELECT COUNT(*) FROM dbo.RequisitionItemApprovals ia
             JOIN dbo.RequisitionItems ri2 ON ri2.RequisitionItemId = ia.RequisitionItemId
             WHERE ri2.RequisitionId = r.RequisitionId AND ia.Decision = 'Rejected') AS RejectedItemCount,
          (SELECT COUNT(*) FROM dbo.CentralStoresItemDecisions cd
             WHERE cd.RequisitionId = r.RequisitionId AND cd.Decision = 'Rejected') AS CentralStoresRejectedItemCount
        FROM dbo.Requisitions r
        LEFT JOIN dbo.Users u  ON u.UserId = r.OpsApprovedByUserId
        LEFT JOIN dbo.Users hu ON hu.UserId = r.HoldByUserId
        LEFT JOIN dbo.Users cs ON cs.UserId = r.CentralStoresApprovedByUserId
        WHERE ${whereClause}
        ORDER BY r.BusyDate DESC, r.BusyOrdNo DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);

    const total = countResult.recordset[0].total;
    res.json({
      data: dataResult.recordset,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total,
      totalPages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisition-approval/:id ───────────────────────────
// Header + items, each item enriched with its current stock picture from
// dbo.ReorderStatus so the Ops Manager can judge if it's still needed,
// plus any per-item decision already on file (from a previous visit that
// held the requisition mid-review, if that ever happens). Also doubles as
// the read-only follow-up detail view for STATUS_VIEW_ROLES.
router.get('/:id', authenticate, authorize(...STATUS_VIEW_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const headerResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT r.*, u.FullName AS OpsApprovedByName, hu.FullName AS HoldByName, cs.FullName AS CentralStoresApprovedByName
        FROM dbo.Requisitions r
        LEFT JOIN dbo.Users u ON u.UserId = r.OpsApprovedByUserId
        LEFT JOIN dbo.Users hu ON hu.UserId = r.HoldByUserId
        LEFT JOIN dbo.Users cs ON cs.UserId = r.CentralStoresApprovedByUserId
        WHERE r.RequisitionId = @id
      `);
    if (!headerResult.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (req.user.role === 'WorkshopHOD' && !isWorkshopMatCenter(headerResult.recordset[0].MatCenter)) {
      return res.status(403).json({ error: 'The Workshop HOD can only view Workshop requisitions' });
    }

    const itemsResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT
          ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty, ri.BusyPrice, ri.BusyAmt, ri.Category,
          rs.LiveStock, rs.ReorderLevel, rs.NeedsReorder, rs.RequiredQty, rs.SyncedAt AS StockSyncedAt,
          rs.AvgMonthlyConsumption, rs.LeadTimeDays, rs.MaxStockLevel, rs.UOM,
          ia.Decision AS ItemDecision, ia.ApprovedQty AS ItemApprovedQty, ia.RejectionReason AS ItemRejectionReason,
          COALESCE(ps.SupplierName, ri.PreferredSupplierName) AS PreferredSupplierName
        FROM dbo.RequisitionItems ri
        -- One row per inventory store per item since 2026-11-11 — take Central
        -- Stores' when the item is in both (F7-only items have just F7's).
        OUTER APPLY (
          SELECT TOP 1 rs2.* FROM dbo.ReorderStatus rs2
          WHERE UPPER(LTRIM(RTRIM(rs2.ItemName))) = UPPER(LTRIM(RTRIM(ri.ItemName)))
          ORDER BY CASE WHEN rs2.Store = 'CENTRAL STORES' THEN 0 ELSE 1 END
        ) rs
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        LEFT JOIN dbo.Suppliers ps ON ps.SupplierId = ri.PreferredSupplierId
        WHERE ri.RequisitionId = @id
        ORDER BY ri.RequisitionItemId
      `);

    // Central Stores' own decisions — the ONLY remaining record of an item
    // it rejected outright (that RequisitionItems row is deleted at that
    // point, see central-stores.routes.js), so a fully-Central-Stores-
    // rejected requisition would otherwise show zero items here.
    const centralStoresDecisionsResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT cd.ItemName, cd.RequestedQty, cd.Decision, cd.ApprovedQty, cd.RejectionReason, cd.DecidedAt,
               du.FullName AS DecidedByName
        FROM dbo.CentralStoresItemDecisions cd
        LEFT JOIN dbo.Users du ON du.UserId = cd.DecidedByUserId
        WHERE cd.RequisitionId = @id
        ORDER BY cd.CentralStoresItemDecisionId
      `);

    res.json({
      ...headerResult.recordset[0],
      items: itemsResult.recordset,
      centralStoresDecisions: centralStoresDecisionsResult.recordset,
      ...(await loadResubmitInfo(pool, id, headerResult.recordset[0])),
    });
  } catch (err) { next(err); }
});

// ── Resubmitting the REJECTED items of a partly-approved requisition ─────────
// (2026-10-26) When only some items were rejected, the approved ones carry
// on to Procurement and the requisition itself can't go back. The clerk
// resubmits the rejected ones instead: they go into a NEW follow-up
// requisition (new REQ number, linked via ResubmittedFromRequisitionId)
// that returns to whoever rejected them — Ops-/HOD-rejected items to that
// gate (Central Stores already passed them), Central-Stores-rejected items
// to Central Stores. Each rejected item can be resubmitted once.
// A WHOLLY rejected requisition keeps the existing /resubmit and
// /central-stores-resubmit (the same requisition goes back).
const RESUBMIT_ROLES = ['FactoryReceiving', 'FactoryQA', 'StoreReceiving', 'Admin'];
const FULLY_REJECTED = ['RejectedByOps', 'RejectedByCentralStores'];
const STILL_IN_REVIEW = ['PendingCentralStoresApproval', 'PendingOpsApproval', 'OnHold'];

async function loadResubmitInfo(pool, id, header) {
  const rejected = [];
  const resubmitted = [];
  if (!FULLY_REJECTED.includes(header.Status) && !STILL_IN_REVIEW.includes(header.Status)) {
    const ops = (await pool.request().input('id', sql.Int, id).query(`
      SELECT ia.RequisitionItemApprovalId AS DecisionId, ri.ItemName, ri.Qty, ri.Unit, ia.RejectionReason, u.FullName AS DecidedBy,
             ia.DecidedAt, ia.ResubmittedInRequisitionId, fr.BusyOrdNo AS ResubmittedInNo
      FROM dbo.RequisitionItemApprovals ia
      JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = ia.RequisitionItemId
      LEFT JOIN dbo.Users u ON u.UserId = ia.DecidedByUserId
      LEFT JOIN dbo.Requisitions fr ON fr.RequisitionId = ia.ResubmittedInRequisitionId
      WHERE ri.RequisitionId = @id AND ia.Decision = 'Rejected'`)).recordset;
    const cs = (await pool.request().input('id', sql.Int, id).query(`
      SELECT cd.CentralStoresItemDecisionId AS DecisionId, cd.ItemName, cd.RequestedQty AS Qty, NULL AS Unit, cd.RejectionReason,
             u.FullName AS DecidedBy, cd.DecidedAt, cd.ResubmittedInRequisitionId, fr.BusyOrdNo AS ResubmittedInNo
      FROM dbo.CentralStoresItemDecisions cd
      LEFT JOIN dbo.Users u ON u.UserId = cd.DecidedByUserId
      LEFT JOIN dbo.Requisitions fr ON fr.RequisitionId = cd.ResubmittedInRequisitionId
      WHERE cd.RequisitionId = @id AND cd.Decision = 'Rejected'`)).recordset;
    const gate = isWorkshopMatCenter(header.MatCenter) ? 'Workshop HOD' : 'Ops Manager';
    for (const [source, list, by] of [['ops', ops, gate], ['cs', cs, 'Central Stores']]) {
      for (const r of list) {
        const row = { source, decisionId: r.DecisionId, itemName: r.ItemName, qty: Math.abs(Number(r.Qty) || 0), unit: r.Unit,
          reason: r.RejectionReason, rejectedBy: r.DecidedBy || by, rejectedAt: r.DecidedAt, stage: by };
        if (r.ResubmittedInRequisitionId) resubmitted.push({ ...row, resubmittedInId: r.ResubmittedInRequisitionId, resubmittedInNo: r.ResubmittedInNo });
        else rejected.push(row);
      }
    }
  }
  const from = header.ResubmittedFromRequisitionId
    ? (await pool.request().input('f', sql.Int, header.ResubmittedFromRequisitionId).query('SELECT RequisitionId, BusyOrdNo FROM dbo.Requisitions WHERE RequisitionId = @f')).recordset[0] || null
    : null;
  return { rejectedForResubmit: rejected, resubmittedItems: resubmitted, resubmittedFrom: from };
}

// May this user resubmit for this Mat Centre? Clerks only for their own Mat Centre.
async function canResubmitFor(pool, user, matCenter) {
  if (user.role === 'Admin') return true;
  const norm = (s) => String(s || '').trim().toUpperCase();
  if (user.role === 'StoreReceiving') return norm(matCenter) === 'CENTRAL STORES';
  const me = (await pool.request().input('u', sql.Int, user.userId).query('SELECT AssignedMatCenter FROM dbo.Users WHERE UserId = @u')).recordset[0];
  return !!me && norm(me.AssignedMatCenter) === norm(matCenter);
}

// ── POST /api/procurement/requisition-approval/:id/resubmit-rejected-items ───
// Body: { items: [{ source: 'ops' | 'cs', decisionId, qty }], note }
router.post('/:id/resubmit-rejected-items', authenticate, authorize(...RESUBMIT_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const note = String(req.body.note || '').trim();
    const picked = Array.isArray(req.body.items) ? req.body.items : [];
    if (!picked.length) return res.status(400).json({ error: 'Pick at least one rejected item to resubmit' });
    if (note.length < 3) return res.status(400).json({ error: 'Say why these items are still needed (note)' });

    const pool = await getPool();
    const header = (await pool.request().input('id', sql.Int, id).query('SELECT * FROM dbo.Requisitions WHERE RequisitionId = @id')).recordset[0];
    if (!header) return res.status(404).json({ error: 'Requisition not found' });
    if (!(await canResubmitFor(pool, req.user, header.MatCenter))) {
      return res.status(403).json({ error: `Only ${header.MatCenter}'s own clerk (or Admin) can resubmit these items` });
    }
    const { rejectedForResubmit } = await loadResubmitInfo(pool, id, header);
    if (FULLY_REJECTED.includes(header.Status)) {
      return res.status(400).json({ error: 'Every item was rejected — use "Resubmit" to send the whole requisition back' });
    }
    const byKey = new Map(rejectedForResubmit.map((r) => [`${r.source}:${r.decisionId}`, r]));
    const chosen = [];
    for (const p of picked) {
      const r = byKey.get(`${p.source}:${parseInt(p.decisionId, 10)}`);
      if (!r) return res.status(400).json({ error: 'One of the items is not a rejected item of this requisition, or was already resubmitted — reload and try again' });
      const qty = Number(p.qty);
      if (!(qty > 0)) return res.status(400).json({ error: `Enter a quantity above 0 for "${r.itemName}"` });
      chosen.push({ ...r, qty });
    }

    // Item details to carry over (Ops-rejected rows still exist; Central Stores deletes the row it rejects).
    const opsIds = chosen.filter((c) => c.source === 'ops').map((c) => c.decisionId);
    const opsDetail = new Map();
    if (opsIds.length) {
      (await pool.request().query(`
        SELECT ia.RequisitionItemApprovalId AS DecisionId, ri.* FROM dbo.RequisitionItemApprovals ia
        JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = ia.RequisitionItemId
        WHERE ia.RequisitionItemApprovalId IN (${opsIds.map((n) => parseInt(n, 10)).join(',')})`)).recordset
        .forEach((r) => opsDetail.set(r.DecisionId, r));
    }
    const csNames = chosen.filter((c) => c.source === 'cs').map((c) => c.itemName);
    const csCategory = csNames.length ? await resolveCategoryForItemNames(csNames) : new Map();

    // Back to whoever rejected them: any Central-Stores-rejected item → Central Stores first;
    // otherwise straight to the Ops Manager / Workshop HOD gate.
    const anyCs = chosen.some((c) => c.source === 'cs');
    const status = anyCs ? 'PendingCentralStoresApproval' : 'PendingOpsApproval';
    const approver = anyCs ? 'Central Stores' : isWorkshopMatCenter(header.MatCenter) ? 'Workshop HOD' : 'Ops Manager';
    const who = req.user.fullName || req.user.username || 'user';
    const notes = `Resubmission of items rejected on ${header.BusyOrdNo} — by ${who}: ${note}`.slice(0, 1000);

    // Required here, not at the top: requisition-create → procurement-sync → this file.
    const { generateRequisitionNo } = require('./requisition-create.routes');
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    let newId; let newNo;
    try {
      newNo = await generateRequisitionNo(transaction);
      newId = (await new sql.Request(transaction)
        .input('no', sql.VarChar(25), newNo)
        .input('date', sql.DateTime, new Date())
        .input('wh', sql.NVarChar(100), header.Warehouse || header.MatCenter)
        .input('mc', sql.NVarChar(100), header.MatCenter)
        .input('status', sql.VarChar(30), status)
        .input('by', sql.Int, req.user.userId)
        .input('notes', sql.NVarChar(1000), notes)
        .input('from', sql.Int, id)
        .input('csBy', sql.Int, anyCs ? null : header.CentralStoresApprovedByUserId)
        .input('csAt', sql.DateTime2, anyCs ? null : header.CentralStoresApprovedAt)
        .query(`
          INSERT INTO dbo.Requisitions (BusyOrdNo, BusyDate, Warehouse, MatCenter, Status, Source, CreatedByUserId, Notes,
                                        ResubmittedFromRequisitionId, CentralStoresApprovedByUserId, CentralStoresApprovedAt)
          OUTPUT INSERTED.RequisitionId
          VALUES (@no, @date, @wh, @mc, @status, 'Manual', @by, @notes, @from, @csBy, @csAt)`)).recordset[0].RequisitionId;

      for (const c of chosen) {
        const d = c.source === 'ops' ? opsDetail.get(c.decisionId) || {} : {};
        await new sql.Request(transaction)
          .input('rid', sql.Int, newId)
          .input('name', sql.NVarChar(200), c.itemName)
          .input('code', sql.NVarChar(50), d.ItemCode || null)
          .input('qty', sql.Float, c.qty)
          .input('unit', sql.NVarChar(20), d.Unit || c.unit || null)
          .input('cat', sql.NVarChar(100), d.Category || csCategory.get(c.itemName) || null)
          .input('supId', sql.Int, d.PreferredSupplierId || null)
          .input('supName', sql.NVarChar(200), d.PreferredSupplierName || null)
          .input('brand', sql.NVarChar(150), d.PreferredBrand || null)
          .input('quality', sql.NVarChar(500), d.PreferredQuality || null)
          .input('photo', sql.NVarChar(500), d.ReferencePhotoUrl || null)
          .query(`
            INSERT INTO dbo.RequisitionItems (RequisitionId, ItemName, ItemCode, Qty, Unit, Category,
                                              PreferredSupplierId, PreferredSupplierName, PreferredBrand, PreferredQuality, ReferencePhotoUrl)
            VALUES (@rid, @name, @code, @qty, @unit, @cat, @supId, @supName, @brand, @quality, @photo)`);
        await new sql.Request(transaction).input('d', sql.Int, c.decisionId).input('rid', sql.Int, newId).query(c.source === 'ops'
          ? 'UPDATE dbo.RequisitionItemApprovals SET ResubmittedInRequisitionId = @rid WHERE RequisitionItemApprovalId = @d AND ResubmittedInRequisitionId IS NULL'
          : 'UPDATE dbo.CentralStoresItemDecisions SET ResubmittedInRequisitionId = @rid WHERE CentralStoresItemDecisionId = @d AND ResubmittedInRequisitionId IS NULL');
      }
      await transaction.commit();
    } catch (trxErr) {
      await transaction.rollback().catch(() => {});
      throw trxErr;
    }

    const items = chosen.map((c) => ({ itemName: c.itemName, qty: c.qty, rejectedBy: c.stage, reason: c.reason }));
    writeAuditLog({
      entityType: 'Requisition', entityId: newId, action: 'Create', userId: req.user.userId,
      newValues: { event: 'RejectedItemsResubmitted', from: header.BusyOrdNo, to: newNo, status, items, note },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    writeStatusHistory({ entityType: 'Requisition', entityId: newId, fromStatus: null, toStatus: status, changedBy: req.user.userId,
      remarks: `Resubmitted rejected items from ${header.BusyOrdNo}` });
    if (status === 'PendingOpsApproval') sendApprovalEmailForRequisition(newId).catch(() => {});

    res.status(201).json({ requisitionId: newId, busyOrdNo: newNo, status, approver, items: chosen.length });
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/requisition-approval/:id/decision ────────────────
// Two shapes, both accepted:
//
//   Whole-requisition (legacy): { decision: 'Approved' | 'Rejected', rejectionReason, notes }
//     — applies the same decision to every item, as before.
//
//   Per-item: { items: [{ requisitionItemId, decision: 'Approved'|'Rejected',
//               approvedQty, rejectionReason }], notes }
//     — every RequisitionItem on this requisition must appear exactly once
//     (same "every item needs a decision" rule the Director's per-item
//     evaluation award uses). The requisition as a whole moves to
//     'Pending' (Procurement's existing flow) as soon as AT LEAST ONE
//     item is approved — rfq.routes.js excludes any item recorded here as
//     Rejected from what actually gets dispatched to suppliers. Only goes
//     to 'RejectedByOps' if EVERY item was rejected.
//
// Callable from 'PendingOpsApproval' OR 'OnHold' — a held requisition can
// be decided directly without a separate "resume" step first.
router.patch('/:id/decision', authenticate, authorize(...DECIDE_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { decision, rejectionReason, notes, items } = req.body;

    const pool = await getPool();
    const current = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT Status, MatCenter FROM dbo.Requisitions WHERE RequisitionId = @id');
    if (!current.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (!canDecideFor(req.user.role, current.recordset[0].MatCenter)) {
      return res.status(403).json({ error: isWorkshopMatCenter(current.recordset[0].MatCenter)
        ? 'Workshop requisitions are decided by the Workshop HOD'
        : 'Factory requisitions are decided by the Ops Manager' });
    }
    if (!['PendingOpsApproval', 'OnHold'].includes(current.recordset[0].Status)) {
      return res.status(400).json({ error: `Requisition is already ${current.recordset[0].Status} — no further action possible` });
    }

    if (Array.isArray(items) && items.length > 0) {
      // ── Per-item decision ──
      const reqItemsResult = await pool.request().input('id', sql.Int, id).query(
        'SELECT RequisitionItemId FROM dbo.RequisitionItems WHERE RequisitionId = @id'
      );
      const requiredItemIds = new Set(reqItemsResult.recordset.map((r) => r.RequisitionItemId));
      if (requiredItemIds.size === 0) {
        return res.status(400).json({ error: 'Requisition has no items to decide on' });
      }

      const seen = new Set();
      for (const it of items) {
        const itemId = parseInt(it?.requisitionItemId, 10);
        if (!itemId || !requiredItemIds.has(itemId)) {
          return res.status(400).json({ error: `Invalid or unknown requisitionItemId: ${it?.requisitionItemId}` });
        }
        if (!['Approved', 'Rejected'].includes(it?.decision)) {
          return res.status(400).json({ error: `Item ${itemId}: decision must be Approved or Rejected` });
        }
        if (it.decision === 'Rejected' && !it.rejectionReason) {
          return res.status(400).json({ error: `Item ${itemId}: rejectionReason is required when rejecting` });
        }
        if (seen.has(itemId)) {
          return res.status(400).json({ error: `Item ${itemId} was decided more than once` });
        }
        seen.add(itemId);
      }
      const missing = [...requiredItemIds].filter((itemId) => !seen.has(itemId));
      if (missing.length > 0) {
        return res.status(400).json({ error: `Every item needs a decision. Missing item id(s): ${missing.join(', ')}` });
      }

      const anyApproved = items.some((it) => it.decision === 'Approved');
      const newStatus = anyApproved ? 'Pending' : 'RejectedByOps';

      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        // Upsert: clear any prior decisions for these items, then insert fresh.
        const idPlaceholders = [...requiredItemIds].map((_, i) => `@i${i}`).join(',');
        const delReq = new sql.Request(transaction);
        [...requiredItemIds].forEach((itemId, i) => delReq.input(`i${i}`, sql.Int, itemId));
        await delReq.query(`DELETE FROM dbo.RequisitionItemApprovals WHERE RequisitionItemId IN (${idPlaceholders})`);

        for (const it of items) {
          await new sql.Request(transaction)
            .input('itemId', sql.Int, parseInt(it.requisitionItemId, 10))
            .input('decision', sql.VarChar(20), it.decision)
            .input('approvedQty', sql.Decimal(12, 2), it.approvedQty != null && it.approvedQty !== '' ? parseFloat(it.approvedQty) : null)
            .input('rejectionReason', sql.NVarChar(500), it.decision === 'Rejected' ? it.rejectionReason : null)
            .input('userId', sql.Int, req.user.userId)
            .query(`
              INSERT INTO dbo.RequisitionItemApprovals
                (RequisitionItemId, Decision, ApprovedQty, RejectionReason, DecidedByUserId)
              VALUES
                (@itemId, @decision, @approvedQty, @rejectionReason, @userId)
            `);
        }

        await new sql.Request(transaction)
          .input('id', sql.Int, id)
          .input('status', sql.VarChar(30), newStatus)
          .input('userId', sql.Int, req.user.userId)
          .input('rejectionReason', sql.NVarChar(1000), anyApproved ? null : 'All items rejected — see per-item reasons')
          .input('notes', sql.NVarChar(1000), notes || null)
          .query(`
            UPDATE dbo.Requisitions
            SET Status = @status,
                OpsApprovedByUserId = @userId,
                OpsApprovedAt = GETUTCDATE(),
                OpsRejectionReason = @rejectionReason,
                OpsNotes = COALESCE(@notes, OpsNotes),
                HoldReason = NULL, HoldByUserId = NULL, HoldAt = NULL
            WHERE RequisitionId = @id
          `);

        await transaction.commit();
      } catch (trxErr) {
        await transaction.rollback();
        throw trxErr;
      }

      return res.json({
        ok: true,
        status: newStatus,
        approvedCount: items.filter((it) => it.decision === 'Approved').length,
        rejectedCount: items.filter((it) => it.decision === 'Rejected').length,
      });
    }

    // ── Legacy whole-requisition decision ──
    if (!decision || !['Approved', 'Rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approved or Rejected' });
    }
    if (decision === 'Rejected' && !rejectionReason) {
      return res.status(400).json({ error: 'rejectionReason is required when rejecting' });
    }

    const newStatus = decision === 'Approved' ? 'Pending' : 'RejectedByOps';

    await pool.request()
      .input('id', sql.Int, id)
      .input('status', sql.VarChar(30), newStatus)
      .input('userId', sql.Int, req.user.userId)
      .input('rejectionReason', sql.NVarChar(1000), decision === 'Rejected' ? rejectionReason : null)
      .input('notes', sql.NVarChar(1000), notes || null)
      .query(`
        UPDATE dbo.Requisitions
        SET Status = @status,
            OpsApprovedByUserId = @userId,
            OpsApprovedAt = GETUTCDATE(),
            OpsRejectionReason = @rejectionReason,
            OpsNotes = COALESCE(@notes, OpsNotes),
            HoldReason = NULL, HoldByUserId = NULL, HoldAt = NULL
        WHERE RequisitionId = @id
      `);

    res.json({ ok: true, status: newStatus });
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/requisition-approval/:id/hold ────────────────────
// Pauses a requisition without approving or rejecting it — e.g. the Ops
// Manager wants a stock recount or more information first. Keeps it out
// of Procurement's queue but visible (badged) in this same pending list
// so it isn't forgotten; callable again from 'OnHold' straight into
// /decision once ready, no separate "resume" step needed.
router.patch('/:id/hold', authenticate, authorize(...DECIDE_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;

    const pool = await getPool();
    const current = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT Status, MatCenter FROM dbo.Requisitions WHERE RequisitionId = @id');
    if (!current.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (!canDecideFor(req.user.role, current.recordset[0].MatCenter)) {
      return res.status(403).json({ error: 'You are not the approver for this requisition' });
    }
    if (current.recordset[0].Status !== 'PendingOpsApproval') {
      return res.status(400).json({ error: `Requisition is ${current.recordset[0].Status} — can only hold from PendingOpsApproval` });
    }

    await holdRequisitionInternal(pool, id, req.user.userId, reason);

    res.json({ ok: true, status: 'OnHold' });
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/requisition-approval/:id/resubmit ────────────────
// Lets the FactoryReceiving clerk who raised the underlying Busy Purchase
// Indent send a fully-rejected requisition back to the Ops Manager after
// addressing whatever the rejection reason said — no need to re-raise the
// indent in Busy. Only valid from 'RejectedByOps' (every item was turned
// down): clears every item's old decision so the Ops Manager reviews it
// completely fresh, same "clean slate" re-review the Goods Receiving side
// already does when a QA rejection sends an entry back for a full
// re-inspection rather than a partial one (see opsmanager.routes.js).
//
// A requisition that's only PARTIALLY rejected (some items approved, still
// 'Pending' or further along) isn't handled here — those items are already
// permanently excluded from RFQ dispatch and there's no per-item ops-review
// queue to put just one item back into; resubmitting only makes sense once
// the whole requisition has dead-ended.
router.patch('/:id/resubmit', authenticate, authorize('FactoryReceiving', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { note } = req.body;

    const pool = await getPool();
    const current = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT Status, BusyOrdNo FROM dbo.Requisitions WHERE RequisitionId = @id');
    if (!current.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (current.recordset[0].Status !== 'RejectedByOps') {
      return res.status(400).json({ error: 'Only a requisition rejected by the Ops Manager can be resubmitted' });
    }

    const resubmittedNote = `Resubmitted by ${req.user.fullName || req.user.username}${note && note.trim() ? `: ${note.trim()}` : ''}`;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction).input('id', sql.Int, id).query(`
        DELETE FROM dbo.RequisitionItemApprovals
        WHERE RequisitionItemId IN (SELECT RequisitionItemId FROM dbo.RequisitionItems WHERE RequisitionId = @id)
      `);

      await new sql.Request(transaction)
        .input('id', sql.Int, id)
        .input('note', sql.NVarChar(1000), resubmittedNote)
        .query(`
          UPDATE dbo.Requisitions
          SET Status = 'PendingOpsApproval',
              OpsApprovedByUserId = NULL, OpsApprovedAt = NULL, OpsRejectionReason = NULL,
              Notes = LTRIM(RTRIM(COALESCE(Notes + CHAR(13) + CHAR(10), '') + @note)),
              UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = @id
        `);

      await transaction.commit();
    } catch (trxErr) {
      await transaction.rollback();
      throw trxErr;
    }

    writeAuditLog({
      entityType: 'Requisition', entityId: id, action: 'StatusChange',
      userId: req.user.userId,
      oldValues: { status: 'RejectedByOps' }, newValues: { status: 'PendingOpsApproval', note },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    writeStatusHistory({
      entityType: 'Requisition', entityId: id,
      fromStatus: 'RejectedByOps', toStatus: 'PendingOpsApproval', changedBy: req.user.userId,
      remarks: resubmittedNote,
    });

    // Re-notify the Ops Manager, same as a fresh sync — fire-and-forget.
    sendApprovalEmailForRequisition(id).catch(() => {});

    res.json({ ok: true, status: 'PendingOpsApproval' });
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/requisition-approval/:id/central-stores-resubmit ──
// Sibling to /:id/resubmit above, for a requisition Central Stores rejected
// entirely ('RejectedByCentralStores') instead of the Ops Manager. Only
// reachable from that status (a requisition rejected only in PART by
// Central Stores never reaches this status — see central-stores.routes.js).
//
// Central Stores rejecting an item DELETES its RequisitionItems row (see
// central-stores.routes.js), so resubmitting has to recreate those rows
// from dbo.CentralStoresItemDecisions' snapshot (ItemName + RequestedQty)
// before flipping the status back — otherwise Central Stores would see an
// empty item list on review. Note: the clerk's original preferred-
// supplier/brand/quality suggestions are NOT preserved in that snapshot,
// so they'd need to be re-entered if this requisition is resubmitted.
router.patch('/:id/central-stores-resubmit', authenticate, authorize('FactoryReceiving', 'FactoryQA', 'Admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { note } = req.body;

    const pool = await getPool();
    const current = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT Status, BusyOrdNo FROM dbo.Requisitions WHERE RequisitionId = @id');
    if (!current.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (current.recordset[0].Status !== 'RejectedByCentralStores') {
      return res.status(400).json({ error: 'Only a requisition rejected by Central Stores can be resubmitted here' });
    }

    const rejectedItems = await pool.request().input('id', sql.Int, id).query(
      "SELECT ItemName, RequestedQty FROM dbo.CentralStoresItemDecisions WHERE RequisitionId = @id AND Decision = 'Rejected'"
    );
    if (rejectedItems.recordset.length === 0) {
      return res.status(400).json({ error: 'No rejected items found to resubmit' });
    }

    const categoryByItemName = await resolveCategoryForItemNames(rejectedItems.recordset.map((r) => r.ItemName));
    const resubmittedNote = `Resubmitted by ${req.user.fullName || req.user.username}${note && note.trim() ? `: ${note.trim()}` : ''}`;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const item of rejectedItems.recordset) {
        await new sql.Request(transaction)
          .input('RequisitionId', sql.Int, id)
          .input('ItemName', sql.NVarChar(200), item.ItemName)
          .input('Qty', sql.Float, item.RequestedQty)
          .input('Category', sql.NVarChar(100), categoryByItemName.get(item.ItemName) || null)
          .query(`
            INSERT INTO dbo.RequisitionItems (RequisitionId, ItemName, Qty, Category)
            VALUES (@RequisitionId, @ItemName, @Qty, @Category)
          `);
      }

      await new sql.Request(transaction)
        .input('id', sql.Int, id)
        .input('note', sql.NVarChar(1000), resubmittedNote)
        .query(`
          UPDATE dbo.Requisitions
          SET Status = 'PendingCentralStoresApproval',
              CentralStoresApprovedByUserId = NULL, CentralStoresApprovedAt = NULL, CentralStoresRejectionReason = NULL,
              Notes = LTRIM(RTRIM(COALESCE(Notes + CHAR(13) + CHAR(10), '') + @note)),
              UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = @id
        `);

      await transaction.commit();
    } catch (trxErr) {
      await transaction.rollback();
      throw trxErr;
    }

    writeAuditLog({
      entityType: 'Requisition', entityId: id, action: 'StatusChange',
      userId: req.user.userId,
      oldValues: { status: 'RejectedByCentralStores' }, newValues: { status: 'PendingCentralStoresApproval', note },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    writeStatusHistory({
      entityType: 'Requisition', entityId: id,
      fromStatus: 'RejectedByCentralStores', toStatus: 'PendingCentralStoresApproval', changedBy: req.user.userId,
      remarks: resubmittedNote,
    });

    res.json({ ok: true, status: 'PendingCentralStoresApproval' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.sendApprovalEmailForRequisition = sendApprovalEmailForRequisition;