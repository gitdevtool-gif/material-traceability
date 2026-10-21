const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { syncSuppliers } = require('../services/supplier-sync.service');

const router = express.Router();

// Simple, permissive email check — good enough to catch typos without
// rejecting valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function generateSupplierCode(pool) {
  // Follow the same NCF-NNNN format used for all real suppliers
  const result = await pool.request().query(`
    SELECT TOP 1
      ISNULL(
        MAX(TRY_CAST(RIGHT(SupplierCode, LEN(SupplierCode) - 4) AS INT)),
        0
      ) AS MaxNum
    FROM dbo.Suppliers
    WHERE SupplierCode LIKE 'NCF-%'
      AND LEN(SupplierCode) >= 5
      AND ISNUMERIC(RIGHT(SupplierCode, LEN(SupplierCode) - 4)) = 1
  `);
  const next = (result.recordset[0].MaxNum || 0) + 1;
  return 'NCF-' + String(next).padStart(4, '0');
}

// ──── GET /api/suppliers ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const { search, active, busyOnly } = req.query;
    const request = pool.request();
    let where = '1=1';
    if (active !== undefined) { where += ' AND IsActive = @active'; request.input('active', sql.Bit, active === 'true' ? 1 : 0); }
    // Busy suppliers carry their numeric Busy party code (supplier-sync);
    // gate-created ones are "NCF-NNNN". The gate only offers Busy ones.
    if (busyOnly === 'true') { where += ' AND TRY_CAST(SupplierCode AS INT) IS NOT NULL'; }
    if (search) { where += ' AND (SupplierCode LIKE @search OR SupplierName LIKE @search)'; request.input('search', sql.NVarChar(100), `%${search}%`); }

    const result = await request.query(`
      SELECT s.*,
        (SELECT STRING_AGG(sc.Category, ', ')
         FROM dbo.SupplierCategories sc
         WHERE sc.SupplierId = s.SupplierId) AS Categories,
        (SELECT STRING_AGG(se.Email, ', ')
         FROM dbo.SupplierEmails se
         WHERE se.SupplierId = s.SupplierId) AS AdditionalEmails
      FROM dbo.Suppliers s
      WHERE ${where}
      ORDER BY s.SupplierName
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── POST /api/suppliers/quick-create ────
// Admin only since 2026-10-17: the gate now picks the supplier's Busy
// account, so deliveries can be matched to Busy POs and GRNs. Gate-typed
// suppliers ("LOICE MAINA" for Busy's "LOISE WANJIKU MAINA") were 46% of
// gate entries and could never be matched.
router.post('/quick-create', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const supplierName = String(req.body.supplierName || '').trim();
    if (!supplierName) {
      return res.status(400).json({ error: 'supplierName is required' });
    }

    const pool = await getPool();
    const existing = await pool.request()
      .input('supplierName', sql.NVarChar(200), supplierName)
      .query(`
        SELECT TOP 1 *
        FROM dbo.Suppliers
        WHERE UPPER(LTRIM(RTRIM(SupplierName))) = UPPER(LTRIM(RTRIM(@supplierName)))
        ORDER BY SupplierId DESC
      `);

    if (existing.recordset[0]) {
      return res.json(existing.recordset[0]);
    }

    const supplierCode = await generateSupplierCode(pool);
    const result = await pool.request()
      .input('supplierCode', sql.VarChar(20), supplierCode)
      .input('supplierName', sql.NVarChar(200), supplierName)
      .query(`INSERT INTO dbo.Suppliers (SupplierCode, SupplierName)
              OUTPUT INSERTED.*
              VALUES (@supplierCode, @supplierName)`);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: 'Supplier already exists' });
    next(err);
  }
});

// ──── POST /api/suppliers ────
router.post('/', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const { supplierCode, supplierName, contactPerson, phone, whatsApp, email, address, categories = [] } = req.body;
    if (!supplierCode || !supplierName) {
      return res.status(400).json({ error: 'supplierCode and supplierName are required' });
    }
    const pool = await getPool();
    const result = await pool.request()
      .input('supplierCode',  sql.VarChar(20),   supplierCode)
      .input('supplierName',  sql.NVarChar(200), supplierName)
      .input('contactPerson', sql.NVarChar(100), contactPerson || null)
      .input('phone',         sql.VarChar(30),   phone || null)
      .input('whatsApp',      sql.VarChar(30),   whatsApp || null)
      .input('email',         sql.VarChar(100),  email || null)
      .input('address',       sql.NVarChar(500), address || null)
      .query(`INSERT INTO dbo.Suppliers (SupplierCode, SupplierName, ContactPerson, Phone, WhatsApp, Email, Address)
              OUTPUT INSERTED.*
              VALUES (@supplierCode, @supplierName, @contactPerson, @phone, @whatsApp, @email, @address)`);
    const supplier = result.recordset[0];

    // Attach supply categories
    for (const cat of categories) {
      if (cat && cat.trim()) {
        await pool.request()
          .input('sid',      sql.Int,           supplier.SupplierId)
          .input('category', sql.NVarChar(100), cat.trim())
          .query(`INSERT INTO dbo.SupplierCategories (SupplierId, Category) VALUES (@sid, @category)`);
      }
    }

    res.status(201).json(supplier);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: 'Supplier code already exists' });
    next(err);
  }
});

// ──── PUT /api/suppliers/:id ────
router.put('/:id', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const { supplierName, contactPerson, phone, whatsApp, email, address, isActive } = req.body;
    const pool = await getPool();
    await pool.request()
      .input('id',            sql.Int,           parseInt(req.params.id))
      .input('supplierName',  sql.NVarChar(200), supplierName)
      .input('contactPerson', sql.NVarChar(100), contactPerson || null)
      .input('phone',         sql.VarChar(30),   phone || null)
      .input('whatsApp',      sql.VarChar(30),   whatsApp || null)
      .input('email',         sql.VarChar(100),  email || null)
      .input('address',       sql.NVarChar(500), address || null)
      .input('isActive',      sql.Bit,           isActive !== undefined ? (isActive ? 1 : 0) : 1)
      .query(`UPDATE dbo.Suppliers
              SET SupplierName=@supplierName, ContactPerson=@contactPerson, Phone=@phone,
                  WhatsApp=@whatsApp, Email=@email, Address=@address, IsActive=@isActive,
                  UpdatedAt=GETUTCDATE()
              WHERE SupplierId=@id`);
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

// ──── GET /api/suppliers/:id/categories ────
router.get('/:id/categories', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .query('SELECT * FROM dbo.SupplierCategories WHERE SupplierId = @id ORDER BY Category');
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── POST /api/suppliers/:id/categories ────
router.post('/:id/categories', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const { category } = req.body;
    if (!category || !category.trim()) {
      return res.status(400).json({ error: 'category is required' });
    }
    const pool = await getPool();
    await pool.request()
      .input('sid',      sql.Int,           parseInt(req.params.id))
      .input('category', sql.NVarChar(100), category.trim())
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.SupplierCategories WHERE SupplierId=@sid AND Category=@category)
          INSERT INTO dbo.SupplierCategories (SupplierId, Category) VALUES (@sid, @category)
      `);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ──── DELETE /api/suppliers/:id/categories/:category ────
router.delete('/:id/categories/:category', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('sid',      sql.Int,           parseInt(req.params.id))
      .input('category', sql.NVarChar(100), req.params.category)
      .query('DELETE FROM dbo.SupplierCategories WHERE SupplierId=@sid AND Category=@category');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ──── GET /api/suppliers/:id/emails ────
// Secondary email recipients for a supplier (e.g. accounts person,
// second contact). Purely local — never touched by supplier-sync.service.js,
// which only owns dbo.Suppliers.Email.
router.get('/:id/emails', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .query(`SELECT * FROM dbo.SupplierEmails WHERE SupplierId = @id ORDER BY CreatedAt`);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── POST /api/suppliers/:id/emails ────
router.post('/:id/emails', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const label = req.body.label ? String(req.body.label).trim() : null;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('sid',   sql.Int,          parseInt(req.params.id))
      .input('email', sql.VarChar(100), email)
      .input('label', sql.NVarChar(50), label)
      .query(`
        INSERT INTO dbo.SupplierEmails (SupplierId, Email, Label)
        OUTPUT INSERTED.*
        VALUES (@sid, @email, @label)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'That email is already added for this supplier' });
    }
    next(err);
  }
});

// ──── DELETE /api/suppliers/:id/emails/:emailId ────
router.delete('/:id/emails/:emailId', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('sid', sql.Int, parseInt(req.params.id))
      .input('eid', sql.Int, parseInt(req.params.emailId))
      .query('DELETE FROM dbo.SupplierEmails WHERE SupplierId=@sid AND SupplierEmailId=@eid');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ──── POST /api/suppliers/sync ────
// Gate / Procurement can refresh too (2026-10-17): the gate only offers Busy
// suppliers now, so a party created in Busy this morning must be pickable
// without waiting for the daily sync.
router.post(
  '/sync',
  authenticate,
  authorize('Admin', 'Procurement', 'GateSecurity', 'Supervisor'),
  async (req, res, next) => {
    try {

      const result = await syncSuppliers();

      res.json(result);

    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;