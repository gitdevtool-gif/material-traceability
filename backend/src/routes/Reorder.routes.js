/**
 * Reorder Routes
 * Detection/alerting dashboard for stock reorder levels, synced from
 * Busy ERP's dbo.reorder view. Read-only against Busy — no order or
 * requisition data is ever created or written back to ERP from here.
 * The actual order request is raised in Busy ERP by a human and flows
 * back into this system through the existing procurement-sync pipeline.
 *
 * Overstocked (added 2026-07-29): dbo.ReorderStatus.Overstocked is
 * synced from Busy's own dbo.reorder view (see reorder-sync.service.js
 * and migrate_add_overstocked_column.sql) — not recomputed here.
 * The main GET / list already returns it via `r.*`, no change needed
 * there. Added: an `overstocked` filter (Overstocked > 0) matching the
 * existing needsReorder filter pattern, and overstocked counts on the
 * /summary endpoint.
 *
 * StockValue (added 2026-08-12): dbo.ReorderStatus.StockValue is also
 * synced from Busy (derived as (Amount/TotalQty)*LiveStock in
 * reorder-sync.service.js) — not recomputed here either. The main GET /
 * list already returns it via `r.*`. Added: TotalStockValue to the
 * /summary endpoint.
 *
 * AvgMonthlyConsumption / MonthsOfSupply (added 2026-08-12):
 * dbo.ReorderStatus.AvgMonthlyConsumption and MonthsOfSupply are synced
 * from Busy's dbo.reorder.AvgQty (see reorder-sync.service.js) — not
 * recomputed here. The main GET / list already returns both via `r.*`.
 *
 * Acknowledge (updated 2026-08-12): acknowledging a row now snapshots
 * the current RequiredQty/MonthsOfSupply into AcknowledgedRequiredQty/
 * AcknowledgedMonthsCoverage in the same UPDATE statement. This freezes
 * "what we knew when we acted" — RequiredQty/MonthsOfSupply keep moving
 * with every hourly sync, so without a snapshot, an old acknowledgement
 * would silently show today's numbers instead of the numbers that were
 * actually true when someone reviewed and acted on it. Unacknowledge
 * clears the snapshot along with the other acknowledgement fields.
 *
 * Factory removed (2026-07-29): dbo.reorder (and therefore
 * dbo.ReorderStatus) has no Factory column — stock/consumption there
 * are already consolidated company-wide. The `factory` filter on the
 * main list has been removed accordingly. The /batches route below is
 * unaffected — it queries live ERP transaction tables (Tran3/Master1)
 * directly for a batch-level drilldown, which is a genuinely different
 * data source that does carry factory at the batch level.
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const { syncReorderStatus } = require('../services/reorder-sync.service');
const stockService = require('../services/stock.service');

const router = express.Router();
const REORDER_ROLES = ['Admin', 'Procurement', 'Director', 'ProductionManager', 'OpsManager'];

// ── GET /api/procurement/reorder ──────────────────────────────────────────────
router.get('/', authenticate, authorize(...REORDER_ROLES), async (req, res, next) => {
  try {
    const { itemgrp, needsReorder, overstocked, acknowledged, search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();
    let where = '1=1';

    if (itemgrp) {
      where += ' AND ItemGroup = @itemgrp';
      request.input('itemgrp', sql.NVarChar(80), itemgrp);
    }
    if (needsReorder !== undefined) {
      where += ' AND NeedsReorder = @needsReorder';
      request.input('needsReorder', sql.Bit, needsReorder === 'true' ? 1 : 0);
    }
    if (overstocked === 'true') {
      where += ' AND ISNULL(Overstocked, 0) > 0';
    } else if (overstocked === 'false') {
      where += ' AND ISNULL(Overstocked, 0) = 0';
    }
    if (acknowledged === 'true') {
      where += ' AND AcknowledgedAt IS NOT NULL';
    } else if (acknowledged === 'false') {
      where += ' AND AcknowledgedAt IS NULL';
    }
    if (search) {
      where += ' AND ItemName LIKE @search';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit',  sql.Int, parseInt(limit));

    const countReq = pool.request();
    if (itemgrp)   countReq.input('itemgrp',       sql.NVarChar(80),  itemgrp);
    if (needsReorder !== undefined) countReq.input('needsReorder', sql.Bit, needsReorder === 'true' ? 1 : 0);
    if (search)    countReq.input('search',        sql.NVarChar(100), `%${search}%`);

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.ReorderStatus WHERE ${where}`),
      request.query(`
        SELECT
          r.*,
          u.FullName AS AcknowledgedByName
        FROM dbo.ReorderStatus r
        LEFT JOIN dbo.Users u ON u.UserId = r.AcknowledgedByUserId
        WHERE ${where}
        ORDER BY
          r.NeedsReorder DESC,
          (r.ReorderLevel - r.LiveStock) DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);

    const total = countResult.recordset[0].total;
    res.json({
      data: dataResult.recordset,
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/reorder/summary ──────────────────────────────────────
// Quick counts for a dashboard header/badge
router.get('/summary', authenticate, authorize(...REORDER_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        COUNT(*) AS TotalItems,
        SUM(CASE WHEN NeedsReorder = 1 THEN 1 ELSE 0 END) AS NeedsReorderCount,
        SUM(CASE WHEN NeedsReorder = 1 AND AcknowledgedAt IS NULL THEN 1 ELSE 0 END) AS UnacknowledgedCount,
        SUM(CASE WHEN ISNULL(Overstocked, 0) > 0 THEN 1 ELSE 0 END) AS OverstockedCount,
        SUM(ISNULL(Overstocked, 0)) AS TotalOverstockedQty,
        SUM(ISNULL(StockValue, 0)) AS TotalStockValue,
        MAX(SyncedAt) AS LastSyncedAt
      FROM dbo.ReorderStatus
    `);
    res.json(result.recordset[0]);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/reorder/batches ────────────────────────────────────
// Batch-wise stock drilldown for a specific item/factory, sourced live
// from Tran3/Master1/MasterCode on the ERP server. Each row is one batch
// (grouped by BatchNo/MasterCode2/Value1/Value3, matching the working
// SSMS query). Qty = SUM(Value2), Amount = SUM(Value3 * Value2).
// AgeDays is computed from the batch Date to now. TotalSleepingAmount is
// the sum of Amount across all returned (positive-qty) batches — i.e.
// total capital currently tied up in genuine on-hand stock for this item
// at this factory.
//
// NOTE: this route's `factory` parameter is unrelated to the Factory
// column removed from dbo.ReorderStatus above — it queries live ERP
// transaction tables, which do carry a genuine per-batch factory. It's
// still required here and still expects the caller to supply one
// explicitly (no longer sourced from a reorder row's own Factory field,
// since that no longer exists).
//
// Only batches whose aggregated Qty (SUM(Value2)) is POSITIVE are
// returned — a negative summed quantity means the batch is oversold/
// negative stock, which isn't "sleeping" inventory and would otherwise
// net against (and understate) the real capital tied up in genuine
// on-hand stock. Since Qty is a SUM (not a raw column), the filter is
// applied with HAVING, after aggregation, same intent as the >0 filter
// on FG's /batches route (which filters the un-aggregated Value1).
// Rebuilt 2026-10-17 (services/stock.service.js getBatchBalances): the old
// query grouped by quantity and price (Value1/Value3) with no RecType
// filter, so a batch's issues never netted against its receipt (HAVING > 0
// then kept only the receipt rows — every batch showed its full received
// qty), supplier challan rows showed up as extra "factories", and it
// required a factory the Reorder page never sends (so it always failed).
// Now: one row per batch per store, true remaining balance, valued at the
// batch's receipt price; `factory` optional; "Materials Consumable" (already
// consumed) left out of sleeping stock; `reconciliation` lists stores where
// Busy's batches don't add up to the item's stock (opening-batch data).
router.get('/batches', authenticate, authorize(...REORDER_ROLES), async (req, res, next) => {
  try {
    const { itemName, factory } = req.query;
    if (!itemName) return res.status(400).json({ error: 'itemName is required' });
    const erpPool = await getErpPool();
    const [item] = await stockService.resolveItems(erpPool, { itemNames: [itemName] });
    if (!item) return res.json({ data: [], totalSleepingAmount: 0, reconciliation: [] });

    const { batches, reconciliation } = await stockService.getBatchBalances(erpPool, { itemCode: item.itemCode, storeName: factory || null });
    const data = batches
      .filter((b) => b.qty > 0 && !stockService.EXCLUDED_STORES.includes(b.storeCode))
      .map((b) => ({
        ItemName: item.itemName, Factory: b.store, BatchNo: b.batchNo, BatchDate: b.batchDate,
        Qty: b.qty, UnitPrice: b.unitPrice, Amount: b.amount, AgeDays: b.ageDays,
        FromOpening: b.fromOpening, LastMovement: b.lastMovement,
      }));
    res.json({
      data,
      totalSleepingAmount: data.reduce((sum, b) => sum + (Number(b.Amount) || 0), 0),
      negativeBatches: batches.filter((b) => b.qty < 0).map((b) => ({ Factory: b.store, BatchNo: b.batchNo, Qty: b.qty })),
      reconciliation: reconciliation.filter((c) => !stockService.EXCLUDED_STORES.some((code) => batches.find((b) => b.store === c.store)?.storeCode === code)),
    });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/reorder/sync ────────────────────────────────────────
router.post('/sync', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const result = await syncReorderStatus();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Sync failed — check ERP connectivity', detail: err.message });
  }
});

// ── POST /api/procurement/reorder/:id/acknowledge ─────────────────────────────
// Snapshots RequiredQty/MonthsOfSupply into AcknowledgedRequiredQty/
// AcknowledgedMonthsCoverage at the moment of acknowledgement, in the
// same UPDATE, so a later resync can't retroactively change what this
// acknowledgement said. See file header note for rationale.
router.post('/:id/acknowledge', authenticate, authorize(...REORDER_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { notes } = req.body;
    const pool = await getPool();

    const result = await pool.request()
      .input('id',    sql.Int,           id)
      .input('userId', sql.Int,          req.user.userId)
      .input('notes', sql.NVarChar(500), notes || null)
      .query(`
        UPDATE dbo.ReorderStatus
        SET AcknowledgedByUserId = @userId,
            AcknowledgedAt = SYSUTCDATETIME(),
            AcknowledgedNotes = @notes,
            AcknowledgedRequiredQty = RequiredQty,
            AcknowledgedMonthsCoverage = MonthsOfSupply
        WHERE ReorderStatusId = @id
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Reorder status row not found' });
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/reorder/:id/unacknowledge ───────────────────────────
// Undo an acknowledgement — e.g. someone marked it reviewed by mistake.
// Clears the AcknowledgedRequiredQty/AcknowledgedMonthsCoverage snapshot
// along with the other acknowledgement fields, since a cleared
// acknowledgement has nothing to snapshot.
router.post('/:id/unacknowledge', authenticate, authorize(...REORDER_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        UPDATE dbo.ReorderStatus
        SET AcknowledgedByUserId = NULL,
            AcknowledgedAt = NULL,
            AcknowledgedNotes = NULL,
            AcknowledgedRequiredQty = NULL,
            AcknowledgedMonthsCoverage = NULL
        WHERE ReorderStatusId = @id
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Reorder status row not found' });
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;