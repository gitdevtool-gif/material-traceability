/**
 * Finished Goods Reorder Routes
 * Detection/alerting for finished-goods stock, driven by sales velocity
 * (dbo.[Sales Report]) instead of purchase lead time. Mirrors the shape
 * of the raw-material reorder routes.
 *
 * FGReorderStatus (synced results + acknowledgements) lives on the LOCAL
 * app database -> getPool(). The batch-aging lookup queries Tran3/Master1/
 * MasterCode directly, which live on the ERP server -> getErpPool().
 *
 * NOTE: this file lives in routes/procurement/, so shared modules are
 * reached via an extra "../" compared to a file directly under routes/.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { getErpPool } = require('../../erpDb');
const { authenticate, authorize } = require('../../middleware/auth');
const { syncFGReorderStatus } = require('../../services/fg-reorder-sync.service');
const stockService = require('../../services/stock.service');

const router = express.Router();
const FG_REORDER_ROLES = ['Admin', 'Procurement', 'Director', 'ProductionManager', 'OpsManager'];

// ── GET /api/procurement/fg-reorder ────────────────────────────────────────────
router.get('/', authenticate, authorize(...FG_REORDER_ROLES), async (req, res, next) => {
  try {
    const { factory, itemgrp, status, acknowledged, search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();
    let where = '1=1';

    if (factory)   { where += ' AND Factory = @factory'; request.input('factory', sql.NVarChar(80), factory); }
    if (itemgrp)   { where += ' AND ItemGroup = @itemgrp'; request.input('itemgrp', sql.NVarChar(50), itemgrp); }
    if (status)    { where += ' AND StockStatus = @status'; request.input('status', sql.NVarChar(30), status); }
    if (acknowledged === 'true')  where += ' AND AcknowledgedAt IS NOT NULL';
    if (acknowledged === 'false') where += ' AND AcknowledgedAt IS NULL';
    if (search)    { where += ' AND ItemName LIKE @search'; request.input('search', sql.NVarChar(100), `%${search}%`); }

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit',  sql.Int, parseInt(limit));

    const countReq = pool.request();
    if (factory) countReq.input('factory', sql.NVarChar(80), factory);
    if (itemgrp) countReq.input('itemgrp', sql.NVarChar(50), itemgrp);
    if (status)  countReq.input('status', sql.NVarChar(30), status);
    if (search)  countReq.input('search', sql.NVarChar(100), `%${search}%`);

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.FGReorderStatus WHERE ${where}`),
      request.query(`
        SELECT r.*, u.FullName AS AcknowledgedByName
        FROM dbo.FGReorderStatus r
        LEFT JOIN dbo.Users u ON u.UserId = r.AcknowledgedByUserId
        WHERE ${where}
        ORDER BY
          CASE StockStatus WHEN 'CRITICAL' THEN 0 WHEN 'REORDER' THEN 1 WHEN 'OK' THEN 2 ELSE 3 END,
          ItemName
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);

    const total = countResult.recordset[0].total;
    res.json({
      data: dataResult.recordset,
      page: parseInt(page), limit: parseInt(limit), total,
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/fg-reorder/summary ────────────────────────────────────
router.get('/summary', authenticate, authorize(...FG_REORDER_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        COUNT(*) AS TotalItems,
        SUM(CASE WHEN StockStatus = 'CRITICAL' THEN 1 ELSE 0 END) AS CriticalCount,
        SUM(CASE WHEN StockStatus = 'REORDER' THEN 1 ELSE 0 END) AS ReorderCount,
        SUM(CASE WHEN Overstocked > 0 THEN 1 ELSE 0 END) AS OverstockedCount,
        SUM(CASE WHEN StockStatus IN ('CRITICAL','REORDER') AND AcknowledgedAt IS NULL THEN 1 ELSE 0 END) AS UnacknowledgedCount,
        MAX(SyncedAt) AS LastSyncedAt
      FROM dbo.FGReorderStatus
    `);
    res.json(result.recordset[0]);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/fg-reorder/sync ──────────────────────────────────────
router.post('/sync', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const result = await syncFGReorderStatus();
    res.json(result);
  } catch (err) {
    // 500, not 502 — Cloudflare replaces raw 502/504 origin responses with its
    // own generic error page, hiding the real error detail from the frontend.
    res.status(500).json({ error: 'Sync failed', detail: err.message });
  }
});

// ── GET /api/procurement/fg-reorder/batches ────────────────────────────────────
// Batch-wise aging lookup for a specific item/factory, sourced live from
// Tran3/Master1/MasterCode on the ERP server. Value1 on Tran3 is the net
// remaining quantity per batch.
//
// Only POSITIVE RemainingQty batches are returned — negative Value1 means
// the batch is oversold/negative stock, which isn't "sleeping" inventory
// and would otherwise net against (and understate) the real capital tied
// up in genuine on-hand stock. totalSleepingAmount is the sum of Amount
// across only those positive batches — i.e. the actual value sitting on
// the shelf for this item/factory.
router.get('/batches', authenticate, authorize(...FG_REORDER_ROLES), async (req, res, next) => {
  try {
    const { itemName, factory } = req.query;
    if (!itemName || !factory) {
      return res.status(400).json({ error: 'itemName and factory are required' });
    }
    // Rebuilt 2026-10-17: the old query listed every positive Tran3 row
    // (receipts only — issues never netted — and order/challan references
    // too). Now true remaining balance per batch, via stock.service.js.
    const erpPool = await getErpPool();
    const itemRow = (await erpPool.request()
      .input('itemName', sql.NVarChar(200), String(itemName).trim().toUpperCase())
      .query(`SELECT TOP 1 Code, LTRIM(RTRIM(Name)) AS Name FROM dbo.Master1
              WHERE MasterType = 6 AND UPPER(LTRIM(RTRIM(REPLACE(Name, '-', ' ')))) = @itemName`)).recordset[0];
    if (!itemRow) return res.json({ data: [], totalSleepingAmount: 0, reconciliation: [] });

    const { batches, reconciliation } = await stockService.getBatchBalances(erpPool, { itemCode: itemRow.Code, storeName: factory });
    const data = batches.filter((b) => b.qty > 0).map((b) => ({
      ItemName: itemRow.Name, Factory: b.store, BatchNo: b.batchNo, BatchDate: b.batchDate,
      RemainingQty: b.qty, UnitPrice: b.unitPrice, Amount: b.amount, AgeDays: b.ageDays,
    }));
    res.json({
      data,
      totalSleepingAmount: data.reduce((sum, b) => sum + (Number(b.Amount) || 0), 0),
      reconciliation,
    });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/fg-reorder/:id/acknowledge ───────────────────────────
router.post('/:id/acknowledge', authenticate, authorize(...FG_REORDER_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { notes } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('userId', sql.Int, req.user.userId)
      .input('notes', sql.NVarChar(500), notes || null)
      .query(`
        UPDATE dbo.FGReorderStatus
        SET AcknowledgedByUserId = @userId, AcknowledgedAt = SYSUTCDATETIME(), AcknowledgedNotes = @notes
        WHERE FGReorderStatusId = @id
      `);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/fg-reorder/:id/unacknowledge ─────────────────────────
router.post('/:id/unacknowledge', authenticate, authorize(...FG_REORDER_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        UPDATE dbo.FGReorderStatus
        SET AcknowledgedByUserId = NULL, AcknowledgedAt = NULL, AcknowledgedNotes = NULL
        WHERE FGReorderStatusId = @id
      `);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;