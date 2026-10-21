const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ──── GET /api/locations ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query("SELECT * FROM dbo.StockLocations WHERE IsActive = 1 ORDER BY LocationName");
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ──── POST /api/locations ────
router.post('/', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { locationName, locationType, description } = req.body;
    if (!locationName || !locationType) {
      return res.status(400).json({ error: 'locationName and locationType are required' });
    }
    const pool = await getPool();
    const result = await pool.request()
      .input('locationName', sql.NVarChar(100), locationName)
      .input('locationType', sql.VarChar(20), locationType)
      .input('description', sql.NVarChar(300), description || null)
      .query(`INSERT INTO dbo.StockLocations (LocationName, LocationType, Description)
              OUTPUT INSERTED.*
              VALUES (@locationName, @locationType, @description)`);
    res.status(201).json(result.recordset[0]);
  } catch (err) { next(err); }
});

module.exports = router;
