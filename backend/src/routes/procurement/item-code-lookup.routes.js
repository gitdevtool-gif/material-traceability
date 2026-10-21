/**
 * Item Code Lookup Routes
 * Admin-managed vlookup table: ItemCode -> real ItemName (+ Category),
 * for items Busy only exposes under a bare product code (e.g. "ING-0141").
 * Consumed by requisition-create.routes.js at creation time; never synced
 * from Busy, since Busy has no such mapping itself.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { applyItemCodeLookupToRequisitionItems } = require('../../services/requisition-item-catalog.service');

const router = express.Router();
const WRITE_ROLES = ['Admin', 'Procurement'];

// ── GET /api/procurement/item-code-lookup ────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT l.ItemCodeLookupId, l.ItemCode, l.ItemName, l.Category,
             l.CreatedAt, l.UpdatedAt, u.FullName AS CreatedByName
      FROM dbo.ItemCodeLookup l
      LEFT JOIN dbo.Users u ON u.UserId = l.CreatedByUserId
      ORDER BY l.ItemCode
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/item-code-lookup ───────────────────────────────────
router.post('/', authenticate, authorize(...WRITE_ROLES), async (req, res, next) => {
  try {
    const { itemCode, itemName, category } = req.body;
    if (!itemCode || !itemName) {
      return res.status(400).json({ error: 'itemCode and itemName are required' });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('ItemCode',        sql.NVarChar(50),  itemCode.trim())
      .input('ItemName',        sql.NVarChar(200), itemName.trim())
      .input('Category',        sql.NVarChar(100), category ? category.trim() : null)
      .input('CreatedByUserId', sql.Int,           req.user.userId)
      .query(`
        INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category, CreatedByUserId)
        OUTPUT INSERTED.*
        VALUES (@ItemCode, @ItemName, @Category, @CreatedByUserId)
      `);
    // Fix any existing requisition items still showing this bare code.
    const itemsResolved = await applyItemCodeLookupToRequisitionItems();
    res.status(201).json({ ...result.recordset[0], itemsResolved });
  } catch (err) {
    if (err.number === 2601 || err.number === 2627) {
      return res.status(409).json({ error: `Code "${req.body.itemCode}" already has a mapping` });
    }
    next(err);
  }
});

// ── POST /api/procurement/item-code-lookup/bulk ──────────────────────────────
// Accepts { rows: [{ itemCode, itemName, category }] } — for pasting the
// whole Excel list in one go from the Admin page. Upserts by ItemCode:
// existing codes get their name/category updated, new codes are inserted.
router.post('/bulk', authenticate, authorize(...WRITE_ROLES), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const cleaned = rows
      .map((r) => ({
        itemCode: String(r.itemCode || '').trim(),
        itemName: String(r.itemName || '').trim(),
        category: r.category ? String(r.category).trim() : null,
      }))
      .filter((r) => r.itemCode && r.itemName);

    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'No valid rows to import (each row needs at least a code and a name)' });
    }

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      let inserted = 0;
      let updated = 0;
      for (const row of cleaned) {
        const result = await new sql.Request(transaction)
          .input('ItemCode',        sql.NVarChar(50),  row.itemCode)
          .input('ItemName',        sql.NVarChar(200), row.itemName)
          .input('Category',        sql.NVarChar(100), row.category)
          .input('CreatedByUserId', sql.Int,           req.user.userId)
          .query(`
            MERGE dbo.ItemCodeLookup AS target
            USING (SELECT @ItemCode AS ItemCode) AS src
            ON target.ItemCode = src.ItemCode
            WHEN MATCHED THEN
              UPDATE SET ItemName = @ItemName, Category = @Category, UpdatedAt = GETUTCDATE()
            WHEN NOT MATCHED THEN
              INSERT (ItemCode, ItemName, Category, CreatedByUserId)
              VALUES (@ItemCode, @ItemName, @Category, @CreatedByUserId)
            OUTPUT $action AS Action;
          `);
        if (result.recordset[0].Action === 'INSERT') inserted += 1; else updated += 1;
      }
      await transaction.commit();
      const itemsResolved = await applyItemCodeLookupToRequisitionItems();
      res.json({ ok: true, inserted, updated, total: cleaned.length, itemsResolved });
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

// ── PUT /api/procurement/item-code-lookup/:id ────────────────────────────────
router.put('/:id', authenticate, authorize(...WRITE_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { itemCode, itemName, category } = req.body;
    if (!itemCode || !itemName) {
      return res.status(400).json({ error: 'itemCode and itemName are required' });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('id',       sql.Int,           id)
      .input('ItemCode', sql.NVarChar(50),  itemCode.trim())
      .input('ItemName', sql.NVarChar(200), itemName.trim())
      .input('Category', sql.NVarChar(100), category ? category.trim() : null)
      .query(`
        UPDATE dbo.ItemCodeLookup
        SET ItemCode = @ItemCode, ItemName = @ItemName, Category = @Category, UpdatedAt = GETUTCDATE()
        OUTPUT INSERTED.*
        WHERE ItemCodeLookupId = @id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Mapping not found' });
    }
    const itemsResolved = await applyItemCodeLookupToRequisitionItems();
    res.json({ ...result.recordset[0], itemsResolved });
  } catch (err) {
    if (err.number === 2601 || err.number === 2627) {
      return res.status(409).json({ error: `Code "${req.body.itemCode}" already has a mapping` });
    }
    next(err);
  }
});

// ── DELETE /api/procurement/item-code-lookup/:id ─────────────────────────────
router.delete('/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM dbo.ItemCodeLookup WHERE ItemCodeLookupId = @id');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
