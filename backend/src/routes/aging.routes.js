/**
 * Aging Analysis Routes
 * Read-only reporting against locally-synced dbo.AgingStock (populated by
 * aging-sync.service.js with true batch balances from Busy). AgeDays
 * is computed here at query time via DATEDIFF, not stored, so it's always
 * current even between syncs.
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { syncAgingStock } = require('../services/aging-sync.service');

const router = express.Router();
const AGING_ROLES = ['Admin', 'Procurement', 'Director', 'ProductionClerk', 'ProductionManager', 'OpsManager'];

// Bucket boundaries (days). Adjust here only — every endpoint uses this SQL fragment.
// BatchDate is nullable (see migration) — without the explicit NULL branch,
// DATEDIFF(day, NULL, GETDATE()) evaluates to NULL, every WHEN fails, and the
// row silently falls through to '180+' as if it were the oldest stock on the
// books. 'Unknown' keeps those rows visible without corrupting the aging picture.
const BUCKET_CASE = `
  CASE
    WHEN BatchDate IS NULL THEN 'Unknown'
    WHEN DATEDIFF(day, BatchDate, GETDATE()) <= 30  THEN '0-30'
    WHEN DATEDIFF(day, BatchDate, GETDATE()) <= 60  THEN '31-60'
    WHEN DATEDIFF(day, BatchDate, GETDATE()) <= 90  THEN '61-90'
    WHEN DATEDIFF(day, BatchDate, GETDATE()) <= 180 THEN '91-180'
    ELSE '180+'
  END
`;

// Qty/Amount are true remaining batch balances (positive) since 2026-10-18 —
// see aging-sync.service.js.
const ALLOWED_SORT = { AgeDays: 'AgeDays', Amount: 'Amount', Qty: 'Qty', ItemName: 'ItemName' };

// Clamp helper — anything non-numeric or out of range falls back to a safe default
// instead of reaching parseInt/NaN into a sql.Int parameter (which throws a raw
// DB error rather than a clean 400).
function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Applies the shared WHERE filters to a given request object and returns the
// WHERE clause string. Used by both the count query and the data query so
// they can never drift apart from each other.
function applyFilters(request, { factory, category, itemName, bucket, minAge }) {
  let where = '1=1';
  if (factory)  { where += ' AND Factory = @factory'; request.input('factory', sql.NVarChar(80), factory); }
  if (category) { where += ' AND Category = @category'; request.input('category', sql.NVarChar(80), category); }
  if (itemName) { where += ' AND ItemName LIKE @itemName'; request.input('itemName', sql.NVarChar(200), `%${itemName}%`); }
  if (bucket)   { where += ` AND (${BUCKET_CASE}) = @bucket`; request.input('bucket', sql.NVarChar(10), bucket); }
  if (minAge !== undefined && minAge !== null && minAge !== '') {
    const parsedMinAge = clampInt(minAge, { min: 0, max: 100000, fallback: null });
    if (parsedMinAge !== null) {
      where += ' AND DATEDIFF(day, BatchDate, GETDATE()) >= @minAge';
      request.input('minAge', sql.Int, parsedMinAge);
    }
  }
  return where;
}

// ── GET /api/production/aging ─────────────────────────────────────────────
router.get('/', authenticate, authorize(...AGING_ROLES), async (req, res, next) => {
  try {
    const { factory, category, itemName, bucket, minAge, sortBy = 'AgeDays', sortDir = 'DESC' } = req.query;
    const pool = await getPool();

    const page = clampInt(req.query.page, { min: 1, max: 1000000, fallback: 1 });
    const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });
    const offset = (page - 1) * limit;

    const sortCol = ALLOWED_SORT[sortBy] || 'AgeDays';
    const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';

    const filterInput = { factory, category, itemName, bucket, minAge };

    const dataReq = pool.request();
    const where = applyFilters(dataReq, filterInput);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);

    const countReq = pool.request();
    applyFilters(countReq, filterInput);

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.AgingStock WHERE ${where}`),
      dataReq.query(`
        SELECT *,
          DATEDIFF(day, BatchDate, GETDATE()) AS AgeDays,
          ${BUCKET_CASE} AS AgeBucket
        FROM dbo.AgingStock
        WHERE ${where}
        ORDER BY ${sortCol} ${dir}, AgingStockId ASC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);

    const total = countResult.recordset[0].total;
    res.json({
      data: dataResult.recordset,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/production/aging/summary ─────────────────────────────────────
// Decision-support view: bucket rollup + overall totals + top offenders.
// Accepts the same filters as GET / (factory, category, itemName, bucket,
// minAge) so the stat cards / bucket bar / top-aging list reflect whatever
// the user has filtered the table to, not the whole dataset. lastSyncedAt
// intentionally stays unfiltered — it's a property of the sync job, not the
// filtered slice of data.
router.get('/summary', authenticate, authorize(...AGING_ROLES), async (req, res, next) => {
  try {
    const { factory, category, itemName, bucket, minAge } = req.query;
    const pool = await getPool();
    const filterInput = { factory, category, itemName, bucket, minAge };

    const bucketsReq = pool.request();
    const bucketsWhere = applyFilters(bucketsReq, filterInput);

    const totalsReq = pool.request();
    const totalsWhere = applyFilters(totalsReq, filterInput);

    const topAgingReq = pool.request();
    const topAgingWhere = applyFilters(topAgingReq, filterInput);

    const [buckets, totals, topAging, lastSync] = await Promise.all([
      bucketsReq.query(`
        SELECT ${BUCKET_CASE} AS Bucket,
               COUNT(*)      AS BatchCount,
               SUM(Qty)      AS TotalQty,
               SUM(Amount)   AS TotalAmount
        FROM dbo.AgingStock
        WHERE ${bucketsWhere}
        GROUP BY ${BUCKET_CASE}
      `),
      totalsReq.query(`
        SELECT COUNT(*) AS TotalBatches,
               SUM(Amount) AS TotalCapital,
               SUM(CASE WHEN DATEDIFF(day, BatchDate, GETDATE()) > 90 THEN Amount ELSE 0 END) AS CapitalOver90Days,
               MAX(DATEDIFF(day, BatchDate, GETDATE())) AS OldestBatchAgeDays,
               SUM(CASE WHEN BatchDate IS NULL THEN 1 ELSE 0 END) AS UnknownDateCount
        FROM dbo.AgingStock
        WHERE ${totalsWhere}
      `),
      topAgingReq.query(`
        SELECT TOP 10 *,
               DATEDIFF(day, BatchDate, GETDATE()) AS AgeDays,
               ${BUCKET_CASE} AS AgeBucket
        FROM dbo.AgingStock
        WHERE (${topAgingWhere}) AND DATEDIFF(day, BatchDate, GETDATE()) > 90
        ORDER BY Amount DESC, AgingStockId ASC
      `),
      pool.request().query(`SELECT MAX(SyncedAt) AS LastSyncedAt FROM dbo.AgingStock`),
    ]);

    // Fixed bucket order regardless of what SQL GROUP BY happened to return.
    // 'Unknown' (null BatchDate) is reported separately rather than folded
    // into 180+, so a Director sees it's a data-quality flag, not aging stock.
    const order = ['0-30', '31-60', '61-90', '91-180', '180+'];
    const bucketMap = Object.fromEntries(buckets.recordset.map(b => [b.Bucket, b]));
    const orderedBuckets = order.map(b => bucketMap[b] || { Bucket: b, BatchCount: 0, TotalQty: 0, TotalAmount: 0 });
    const unknownBucket = bucketMap['Unknown'] || null;

    res.json({
      buckets: orderedBuckets,
      unknownBucket,                      // { Bucket: 'Unknown', BatchCount, TotalQty, TotalAmount } | null
      totals: totals.recordset[0],
      topAging: topAging.recordset,       // the actual "act on this" list
      lastSyncedAt: lastSync.recordset[0].LastSyncedAt,
    });
  } catch (err) { next(err); }
});

// ── POST /api/production/aging/sync ───────────────────────────────────────
router.post('/sync', authenticate, authorize('Admin', 'Procurement'), async (_req, res) => {
  try {
    const result = await syncAgingStock();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Sync failed — check ERP connectivity', detail: err.message });
  }
});

// ── POST /api/production/aging/reset-sync ─────────────────────────────────
// Destructive: wipes dbo.AgingStock (TRUNCATE, resets identity, so
// AgingStockId restarts at 1) then runs a full fresh sync. The normal
// /sync endpoint's MERGE already reconciles stale rows away too (2026-09-23
// — see aging-sync.service.js), so the two mainly differ in identity reset
// and guaranteeing a completely clean rebuild; use this if the ERP-side
// view/filter logic itself changed and you want a from-scratch rebuild.
//
// Admin-only (not Procurement) since it discards history, unlike /sync.
router.post('/reset-sync', authenticate, authorize('Admin'), async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('TRUNCATE TABLE dbo.AgingStock');
    const result = await syncAgingStock();
    res.json({ ...result, reset: true });
  } catch (err) {
    res.status(502).json({ error: 'Reset & sync failed — check ERP connectivity', detail: err.message });
  }
});

module.exports = router;