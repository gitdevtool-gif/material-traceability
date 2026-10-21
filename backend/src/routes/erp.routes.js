/**
 * ERP Integration Route — Read-only access to Busy ERP GoodsReceived view.
 * Cross-reference data from the Busy ERP system on server 192.168.1.109.
 */
const express = require('express');
const { getErpPool, sql } = require('../erpDb');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Simple in-memory cache for ERP products list
let erpProductsCache = { data: null, expiry: 0 };
const ERP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ──── GET /api/erp/goods-received — Query Busy ERP GoodsReceived view ────
router.get('/goods-received', authenticate, async (req, res, next) => {
  try {
    const { vchNo, name, dateFrom, dateTo, search, page = 1, limit = 50 } = req.query;
    const pool = await getErpPool();
    const request = pool.request();

    let where = '1=1';
    if (vchNo) { where += ' AND gr.VchNo = @vchNo'; request.input('vchNo', sql.NVarChar(50), vchNo); }
    if (name) { where += ' AND gr.Name LIKE @name'; request.input('name', sql.NVarChar(200), `%${name}%`); }
    if (dateFrom) { where += ' AND gr.[Date] >= @dateFrom'; request.input('dateFrom', sql.Date, dateFrom); }
    if (dateTo) { where += ' AND gr.[Date] <= @dateTo'; request.input('dateTo', sql.Date, dateTo); }
    if (search) {
      where += ' AND (gr.VchNo LIKE @search OR gr.Name LIKE @search OR gr.[Batch No] LIKE @search OR gr.[Mat Center] LIKE @search)';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    // Count query (separate request to avoid input conflicts)
    const countReq = pool.request();
    if (vchNo) countReq.input('vchNo', sql.NVarChar(50), vchNo);
    if (name) countReq.input('name', sql.NVarChar(200), `%${name}%`);
    if (dateFrom) countReq.input('dateFrom', sql.Date, dateFrom);
    if (dateTo) countReq.input('dateTo', sql.Date, dateTo);
    if (search) countReq.input('search', sql.NVarChar(100), `%${search}%`);
    // Run count and data queries in parallel
    const [countResult, result] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.GoodsReceived gr WHERE ${where}`),
      request.query(`
        SELECT gr.VchCode, gr.VchType, gr.[Date], gr.VchNo, gr.MasterCode1, gr.MasterCode2,
               gr.Name, gr.[Batch No], gr.VchSeriesCode, gr.[Mat Center],
               gr.Qty, gr.Price, gr.Amount, gr.[Date Received], gr.DueDate
        FROM dbo.GoodsReceived gr
        WHERE ${where}
        ORDER BY gr.[Date] DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);
    const total = countResult.recordset[0].total;

    const pg = parseInt(page);
    const lim = parseInt(limit);
    res.json({ data: result.recordset, page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });
  } catch (err) {
    if (err.code === 'ENOTOPEN' || err.code === 'ECONNCLOSED' || err.message.includes('connect')) {
      return res.status(503).json({ error: 'ERP database is not reachable. Please check the connection.' });
    }
    next(err);
  }
});

// ──── GET /api/erp/goods-received/:vchNo — Lookup specific voucher ────
router.get('/goods-received/:vchNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getErpPool();
    const result = await pool.request()
      .input('vchNo', sql.NVarChar(50), req.params.vchNo)
      .query(`
        SELECT gr.VchCode, gr.VchType, gr.[Date], gr.VchNo, gr.MasterCode1, gr.MasterCode2,
               gr.Name, gr.[Batch No], gr.VchSeriesCode, gr.[Mat Center],
               gr.Qty, gr.Price, gr.Amount, gr.[Date Received], gr.DueDate
        FROM dbo.GoodsReceived gr
        WHERE gr.VchNo = @vchNo
        ORDER BY gr.[Date] DESC
      `);

    if (!result.recordset.length) return res.status(404).json({ error: 'Voucher not found in ERP' });
    res.json(result.recordset);
  } catch (err) {
    if (err.code === 'ENOTOPEN' || err.code === 'ECONNCLOSED' || err.message.includes('connect')) {
      return res.status(503).json({ error: 'ERP database is not reachable' });
    }
    next(err);
  }
});

// ──── GET /api/erp/health — Check ERP DB connectivity ────
router.get('/health', authenticate, async (_req, res) => {
  try {
    const pool = await getErpPool();
    await pool.request().query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', server: '192.168.1.109' });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected', server: '192.168.1.109' });
  }
});

// ──── GET /api/erp/products — Distinct product names from ERP GoodsReceived ────
router.get('/products', authenticate, async (req, res, next) => {
  try {
    // Return cached data if not searching and cache is fresh
    if (!req.query.search && erpProductsCache.data && Date.now() < erpProductsCache.expiry) {
      res.set('X-Cache', 'HIT');
      return res.json(erpProductsCache.data);
    }

    const pool = await getErpPool();
    const request = pool.request();
    let where = '1=1';
    if (req.query.search) {
      where += ' AND gr.Name LIKE @search';
      request.input('search', sql.NVarChar(200), `%${req.query.search}%`);
    }
    const result = await request.query(`
      SELECT DISTINCT gr.Name
      FROM dbo.GoodsReceived gr
      WHERE gr.Name IS NOT NULL AND LEN(LTRIM(RTRIM(gr.Name))) > 0 AND ${where}
      ORDER BY gr.Name
    `);
    const data = result.recordset.map(r => r.Name);

    // Cache full list (no search filter)
    if (!req.query.search) {
      erpProductsCache = { data, expiry: Date.now() + ERP_CACHE_TTL };
    }

    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch (err) {
    if (err.code === 'ENOTOPEN' || err.code === 'ECONNCLOSED' || err.message.includes('connect')) {
      return res.status(503).json({ error: 'ERP database is not reachable' });
    }
    next(err);
  }
});

module.exports = router;
