/**
 * Order trace routes (2026-10-17) — requisition → … → payment, read-only.
 *   GET /api/trace/requisition/:id
 *   GET /api/trace/find?q=          requisition no., RFQ no. or Busy PO no. → requisition ids
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool } = require('../erpDb');
const { authenticate } = require('../middleware/auth');
const { traceRequisition } = require('../services/trace.service');
const { resolveItems } = require('../services/stock.service');

const router = express.Router();

router.get('/requisition/:id', authenticate, async (req, res, next) => {
  try {
    const result = await traceRequisition(await getPool(), await getErpPool(), parseInt(req.params.id, 10), { resolveItems });
    if (!result) return res.status(404).json({ error: 'Requisition not found' });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/find', authenticate, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json([]);
    const result = await (await getPool()).request()
      .input('q', sql.NVarChar(60), `%${q}%`)
      .query(`
        SELECT DISTINCT TOP 25 r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Status, r.MatCenter,
               rfq.RFQNumber, LTRIM(RTRIM(rec.BusyPurOrdNo)) AS BusyPurOrdNo
        FROM dbo.Requisitions r
        LEFT JOIN dbo.RequisitionItems ri ON ri.RequisitionId = r.RequisitionId
        LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = ri.RFQId
        LEFT JOIN dbo.LPOReconciliation rec ON rec.RFQId = rfq.RFQId
        WHERE r.BusyOrdNo LIKE @q OR rfq.RFQNumber LIKE @q OR rec.BusyPurOrdNo LIKE @q OR ri.ItemName LIKE @q
        ORDER BY r.BusyDate DESC`);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

module.exports = router;
