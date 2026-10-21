/**
 * Item Category Map Routes
 * Admin-managed table: ItemPattern + MatchType → Category
 * Used by the sync job to auto-classify PurIndents items.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');

const router = express.Router();
const ADMIN_PROCUREMENT = ['Admin', 'Procurement'];

// ── GET /api/procurement/item-categories ─────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT m.ItemCategoryMapId, m.ItemPattern, m.MatchType, m.Category,
             m.SortOrder, m.CreatedAt, m.UpdatedAt,
             u.FullName AS CreatedByName
      FROM dbo.ItemCategoryMap m
      LEFT JOIN dbo.Users u ON u.UserId = m.CreatedByUserId
      ORDER BY m.SortOrder, m.Category, m.ItemPattern
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/item-categories/categories ──────────────────────────
// Returns distinct category list (for dropdowns)
router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT Category FROM dbo.ItemCategoryMap ORDER BY Category
    `);
    res.json(result.recordset.map((r) => r.Category));
  } catch (err) { next(err); }
});

// ── POST /api/procurement/item-categories ────────────────────────────────────
router.post('/', authenticate, authorize(...ADMIN_PROCUREMENT), async (req, res, next) => {
  try {
    const { itemPattern, matchType = 'contains', category, sortOrder = 50 } = req.body;
    if (!itemPattern || !category) {
      return res.status(400).json({ error: 'itemPattern and category are required' });
    }
    if (!['exact', 'contains', 'starts_with'].includes(matchType)) {
      return res.status(400).json({ error: 'matchType must be exact, contains, or starts_with' });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('ItemPattern',     sql.NVarChar(200), itemPattern.trim())
      .input('MatchType',       sql.VarChar(20),   matchType)
      .input('Category',        sql.NVarChar(100), category.trim())
      .input('SortOrder',       sql.Int,           Number(sortOrder))
      .input('CreatedByUserId', sql.Int,           req.user.userId)
      .query(`
        INSERT INTO dbo.ItemCategoryMap
          (ItemPattern, MatchType, Category, SortOrder, CreatedByUserId)
        OUTPUT INSERTED.*
        VALUES
          (@ItemPattern, @MatchType, @Category, @SortOrder, @CreatedByUserId)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/procurement/item-categories/:id ─────────────────────────────────
router.put('/:id', authenticate, authorize(...ADMIN_PROCUREMENT), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { itemPattern, matchType, category, sortOrder } = req.body;
    if (!itemPattern || !category) {
      return res.status(400).json({ error: 'itemPattern and category are required' });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('id',          sql.Int,           id)
      .input('ItemPattern', sql.NVarChar(200), itemPattern.trim())
      .input('MatchType',   sql.VarChar(20),   matchType || 'contains')
      .input('Category',    sql.NVarChar(100), category.trim())
      .input('SortOrder',   sql.Int,           Number(sortOrder || 50))
      .query(`
        UPDATE dbo.ItemCategoryMap
        SET ItemPattern = @ItemPattern,
            MatchType   = @MatchType,
            Category    = @Category,
            SortOrder   = @SortOrder,
            UpdatedAt   = GETUTCDATE()
        OUTPUT INSERTED.*
        WHERE ItemCategoryMapId = @id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }
    res.json(result.recordset[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/procurement/item-categories/:id ──────────────────────────────
router.delete('/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM dbo.ItemCategoryMap WHERE ItemCategoryMapId = @id');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
