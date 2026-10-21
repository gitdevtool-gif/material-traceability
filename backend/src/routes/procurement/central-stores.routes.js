/**
 * Central Stores Routes
 *
 * Reviews every requisition raised in-system (see requisition-create.routes.js)
 * BEFORE it reaches the existing downstream flow — checks physical stock,
 * can adjust quantities or drop items outright, and can reject an item
 * with a reason. What Central Stores approves and forwards continues on
 * exactly as before this change: factory-MatCenter requisitions still hit
 * the existing, unchanged Ops Manager gate (PendingOpsApproval); everything
 * else goes straight to 'Pending', visible to Procurement.
 *
 * Deliberately does NOT touch dbo.RequisitionItemApprovals (the Ops
 * Manager's own decision table) — that table is joined, unfiltered, by
 * 8+ already-live RFQ/evaluation query sites that assume at most one
 * decision row per item. Central Stores' decisions go into their own
 * dbo.CentralStoresItemDecisions audit table instead; a rejected item is
 * simply deleted from dbo.RequisitionItems, which is safe here because
 * nothing downstream (RFQ, quoting, evaluation) has referenced it yet —
 * unlike an Ops Manager rejection, which happens after sibling items may
 * already be moving through RFQ and so must stay in place.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { matCenterRequiresOpsApproval } = require('../../services/procurement-sync.service');

const router = express.Router();
const ROLES = ['StoreReceiving', 'Admin'];

// ── GET /api/procurement/central-stores/pending ──────────────────────────────
router.get('/pending', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter,
        r.Status, r.CreatedAt,
        u.FullName AS CreatedByName,
        (SELECT COUNT(*) FROM dbo.RequisitionItems ri WHERE ri.RequisitionId = r.RequisitionId) AS ItemCount
      FROM dbo.Requisitions r
      LEFT JOIN dbo.Users u ON u.UserId = r.CreatedByUserId
      WHERE r.Status = 'PendingCentralStoresApproval'
      ORDER BY r.BusyDate ASC, r.BusyOrdNo ASC
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/central-stores/:id ──────────────────────────────────
router.get('/:id', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const headerResult = await pool.request().input('id', sql.Int, id).query(`
      SELECT r.*, u.FullName AS CreatedByName
      FROM dbo.Requisitions r
      LEFT JOIN dbo.Users u ON u.UserId = r.CreatedByUserId
      WHERE r.RequisitionId = @id
    `);
    if (!headerResult.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });

    const itemsResult = await pool.request().input('id', sql.Int, id).query(`
      SELECT
        ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty, ri.Unit, ri.Category,
        ri.PreferredSupplierId,
        COALESCE(ps.SupplierName, ri.PreferredSupplierName) AS PreferredSupplierName,
        ri.PreferredBrand, ri.PreferredQuality
      FROM dbo.RequisitionItems ri
      LEFT JOIN dbo.Suppliers ps ON ps.SupplierId = ri.PreferredSupplierId
      WHERE ri.RequisitionId = @id
      ORDER BY ri.RequisitionItemId
    `);

    res.json({ ...headerResult.recordset[0], items: itemsResult.recordset });
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/central-stores/:id/decision ───────────────────────
// Body: { items: [{ requisitionItemId, decision: 'Approved'|'Rejected', approvedQty, rejectionReason }], notes }
// Every item on the requisition must appear exactly once, same "every
// item needs a decision" rule requisition-approval.routes.js uses.
router.patch('/:id/decision', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { items, notes } = req.body;

    const pool = await getPool();
    const current = await pool.request().input('id', sql.Int, id).query(
      'SELECT Status, MatCenter FROM dbo.Requisitions WHERE RequisitionId = @id'
    );
    if (!current.recordset[0]) return res.status(404).json({ error: 'Requisition not found' });
    if (current.recordset[0].Status !== 'PendingCentralStoresApproval') {
      return res.status(400).json({ error: `Requisition is already ${current.recordset[0].Status} — no further action possible` });
    }
    const matCenter = current.recordset[0].MatCenter;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const reqItemsResult = await pool.request().input('id', sql.Int, id).query(
      'SELECT RequisitionItemId, ItemName, Qty FROM dbo.RequisitionItems WHERE RequisitionId = @id'
    );
    const itemsById = new Map(reqItemsResult.recordset.map((r) => [r.RequisitionItemId, r]));
    if (itemsById.size === 0) {
      return res.status(400).json({ error: 'Requisition has no items to decide on' });
    }

    const seen = new Set();
    for (const it of items) {
      const itemId = parseInt(it?.requisitionItemId, 10);
      if (!itemId || !itemsById.has(itemId)) {
        return res.status(400).json({ error: `Invalid or unknown requisitionItemId: ${it?.requisitionItemId}` });
      }
      if (!['Approved', 'Rejected'].includes(it?.decision)) {
        return res.status(400).json({ error: `Item ${itemId}: decision must be Approved or Rejected` });
      }
      if (it.decision === 'Rejected' && !it.rejectionReason) {
        return res.status(400).json({ error: `Item ${itemId}: rejectionReason is required when rejecting` });
      }
      if (it.decision === 'Approved') {
        const qty = parseFloat(it.approvedQty);
        if (!Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ error: `Item ${itemId}: approvedQty must be a positive number` });
        }
      }
      if (seen.has(itemId)) {
        return res.status(400).json({ error: `Item ${itemId} was decided more than once` });
      }
      seen.add(itemId);
    }
    const missing = [...itemsById.keys()].filter((itemId) => !seen.has(itemId));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Every item needs a decision. Missing item id(s): ${missing.join(', ')}` });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const it of items) {
        const itemId = parseInt(it.requisitionItemId, 10);
        const original = itemsById.get(itemId);

        await new sql.Request(transaction)
          .input('RequisitionId', sql.Int, id)
          .input('ItemName', sql.NVarChar(200), original.ItemName)
          .input('RequestedQty', sql.Decimal(12, 2), original.Qty)
          .input('Decision', sql.VarChar(20), it.decision)
          .input('ApprovedQty', sql.Decimal(12, 2), it.decision === 'Approved' ? parseFloat(it.approvedQty) : null)
          .input('RejectionReason', sql.NVarChar(500), it.decision === 'Rejected' ? it.rejectionReason : null)
          .input('DecidedByUserId', sql.Int, req.user.userId)
          .query(`
            INSERT INTO dbo.CentralStoresItemDecisions
              (RequisitionId, ItemName, RequestedQty, Decision, ApprovedQty, RejectionReason, DecidedByUserId)
            VALUES
              (@RequisitionId, @ItemName, @RequestedQty, @Decision, @ApprovedQty, @RejectionReason, @DecidedByUserId)
          `);

        if (it.decision === 'Approved') {
          await new sql.Request(transaction)
            .input('itemId', sql.Int, itemId)
            .input('qty', sql.Float, parseFloat(it.approvedQty))
            .query('UPDATE dbo.RequisitionItems SET Qty = @qty WHERE RequisitionItemId = @itemId');
        } else {
          await new sql.Request(transaction)
            .input('itemId', sql.Int, itemId)
            .query('DELETE FROM dbo.RequisitionItems WHERE RequisitionItemId = @itemId');
        }
      }

      const remaining = await new sql.Request(transaction).input('id', sql.Int, id).query(
        'SELECT COUNT(*) AS cnt FROM dbo.RequisitionItems WHERE RequisitionId = @id'
      );
      const anyRemaining = remaining.recordset[0].cnt > 0;
      const newStatus = !anyRemaining
        ? 'RejectedByCentralStores'
        : matCenterRequiresOpsApproval(matCenter)
          ? 'PendingOpsApproval'
          : 'Pending';

      await new sql.Request(transaction)
        .input('id', sql.Int, id)
        .input('status', sql.VarChar(30), newStatus)
        .input('userId', sql.Int, req.user.userId)
        .input('notes', sql.NVarChar(1000), notes || null)
        .input('rejectionReason', sql.NVarChar(1000), anyRemaining ? null : 'All items rejected — see per-item reasons')
        .query(`
          UPDATE dbo.Requisitions
          SET Status = @status,
              CentralStoresApprovedByUserId = @userId,
              CentralStoresApprovedAt = GETUTCDATE(),
              CentralStoresRejectionReason = @rejectionReason,
              CentralStoresNotes = COALESCE(@notes, CentralStoresNotes),
              UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = @id
        `);

      await transaction.commit();

      res.json({
        ok: true,
        status: newStatus,
        approvedCount: items.filter((it) => it.decision === 'Approved').length,
        rejectedCount: items.filter((it) => it.decision === 'Rejected').length,
      });
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

module.exports = router;
