const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

async function generateMaterialCode(pool) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const result = await pool.request()
    .input('seqType', sql.VarChar(20), 'MATERIAL')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);

  return `MAT-${today}-${String(result.recordset[0].LastNumber).padStart(4, '0')}`;
}

// ──── GET /api/materials ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const { search, category, active } = req.query;
    const request = pool.request();
    let where = '1=1';
    if (active !== undefined) { where += ' AND IsActive = @active'; request.input('active', sql.Bit, active === 'true' ? 1 : 0); }
    if (category) { where += ' AND Category = @category'; request.input('category', sql.VarChar(50), category); }
    if (search) { where += ' AND (MaterialCode LIKE @search OR MaterialName LIKE @search)'; request.input('search', sql.NVarChar(100), `%${search}%`); }

    const result = await request.query(`SELECT * FROM dbo.Materials WHERE ${where} ORDER BY MaterialName`);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── POST /api/materials/quick-create ────
router.post('/quick-create', authenticate, authorize('GateSecurity', 'Admin'), async (req, res, next) => {
  try {
    const materialName = String(req.body.materialName || '').trim();
    const uom = String(req.body.uom || 'kg').trim() || 'kg';
    if (!materialName) {
      return res.status(400).json({ error: 'materialName is required' });
    }

    const pool = await getPool();
    const existing = await pool.request()
      .input('materialName', sql.NVarChar(200), materialName)
      .query(`
        SELECT TOP 1 *
        FROM dbo.Materials
        WHERE UPPER(LTRIM(RTRIM(MaterialName))) = UPPER(LTRIM(RTRIM(@materialName)))
        ORDER BY MaterialId DESC
      `);

    if (existing.recordset[0]) {
      return res.json(existing.recordset[0]);
    }

    const materialCode = await generateMaterialCode(pool);
    const result = await pool.request()
      .input('materialCode', sql.VarChar(30), materialCode)
      .input('materialName', sql.NVarChar(200), materialName)
      .input('category', sql.VarChar(50), 'RawMaterial')
      .input('uom', sql.VarChar(20), uom)
      .query(`INSERT INTO dbo.Materials (MaterialCode, MaterialName, Category, UOM)
              OUTPUT INSERTED.*
              VALUES (@materialCode, @materialName, @category, @uom)`);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: 'Material already exists' });
    next(err);
  }
});

// ──── POST /api/materials ────
router.post('/', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { materialCode, materialName, category, uom, minStock, maxStock } = req.body;
    if (!materialCode || !materialName || !uom) {
      return res.status(400).json({ error: 'materialCode, materialName, and uom are required' });
    }
    const pool = await getPool();
    const result = await pool.request()
      .input('materialCode', sql.VarChar(30), materialCode)
      .input('materialName', sql.NVarChar(200), materialName)
      .input('category', sql.VarChar(50), category || null)
      .input('uom', sql.VarChar(20), uom)
      .input('minStock', sql.Decimal(12, 2), minStock || null)
      .input('maxStock', sql.Decimal(12, 2), maxStock || null)
      .query(`INSERT INTO dbo.Materials (MaterialCode, MaterialName, Category, UOM, MinStock, MaxStock)
              OUTPUT INSERTED.*
              VALUES (@materialCode, @materialName, @category, @uom, @minStock, @maxStock)`);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: 'Material code already exists' });
    next(err);
  }
});

// ──── PUT /api/materials/:id ────
router.put('/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { materialName, category, uom, minStock, maxStock, isActive } = req.body;
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .input('materialName', sql.NVarChar(200), materialName)
      .input('category', sql.VarChar(50), category || null)
      .input('uom', sql.VarChar(20), uom)
      .input('minStock', sql.Decimal(12, 2), minStock || null)
      .input('maxStock', sql.Decimal(12, 2), maxStock || null)
      .input('isActive', sql.Bit, isActive !== undefined ? (isActive ? 1 : 0) : 1)
      .query(`UPDATE dbo.Materials
              SET MaterialName=@materialName, Category=@category, UOM=@uom,
                  MinStock=@minStock, MaxStock=@maxStock, IsActive=@isActive, UpdatedAt=GETUTCDATE()
              WHERE MaterialId=@id`);
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

module.exports = router;
