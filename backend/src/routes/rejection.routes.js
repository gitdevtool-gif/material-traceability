const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');

const router = express.Router();

// ──── Helper: generate next Rejection No ────
async function generateRejectionNo(transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = new sql.Request(transaction);
  const result = await req
    .input('seqType', sql.VarChar(20), 'REJ')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);
  const seq = result.recordset[0].LastNumber;
  return `REJ-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── POST /api/rejections — Create Goods Rejection Note ────
router.post('/', authenticate, authorize('QAInspector', 'QAManager', 'Supervisor', 'Admin'), async (req, res, next) => {
  try {
    const { entryNo, rejectionReason, notes, items } = req.body;
    if (!entryNo || !rejectionReason) return res.status(400).json({ error: 'entryNo and rejectionReason are required' });

    const pool = await getPool();

    // Validate entry
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query('SELECT EntryId, Status, VersionNo FROM dbo.DeliveryEntries WHERE EntryNo = @entryNo');
    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    if (!['QARejected', 'Quarantine', 'WeighbridgeCompleted'].includes(entry.Status)) {
      return res.status(400).json({ error: `Cannot reject — entry status is ${entry.Status}` });
    }

    // Get QA inspection if exists
    const qaResult = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query('SELECT InspectionId FROM dbo.QAInspections WHERE EntryId = @entryId');
    const inspectionId = qaResult.recordset[0]?.InspectionId || null;

    // Check no existing rejection
    const existingRej = await pool.request()
      .input('entryId2', sql.Int, entry.EntryId)
      .query('SELECT RejectionId FROM dbo.GoodsRejectionNotes WHERE EntryId = @entryId2');
    if (existingRej.recordset.length > 0) {
      return res.status(409).json({ error: 'A rejection note already exists for this entry' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const rejNo = await generateRejectionNo(transaction);

      const rejReq = new sql.Request(transaction);
      const result = await rejReq
        .input('rejNo', sql.VarChar(20), rejNo)
        .input('entryId', sql.Int, entry.EntryId)
        .input('inspectionId', sql.Int, inspectionId)
        .input('rejectedBy', sql.Int, req.user.userId)
        .input('rejectionReason', sql.NVarChar(1000), rejectionReason)
        .input('notes', sql.NVarChar(500), notes || null)
        .query(`INSERT INTO dbo.GoodsRejectionNotes
          (RejectionNo, EntryId, InspectionId, RejectedBy, RejectionReason, Notes)
          OUTPUT INSERTED.RejectionId, INSERTED.RejectionNo, INSERTED.RejectionDate
          VALUES (@rejNo, @entryId, @inspectionId, @rejectedBy, @rejectionReason, @notes)`);
      const rejection = result.recordset[0];

      // Insert rejection line items
      if (items && items.length > 0) {
        for (const item of items) {
          const itemReq = new sql.Request(transaction);
          await itemReq
            .input('rejId', sql.Int, rejection.RejectionId)
            .input('materialId', sql.Int, item.materialId)
            .input('rejectedQty', sql.Decimal(12, 2), item.rejectedQty)
            .input('uom', sql.VarChar(20), item.uom)
            .input('rejReason', sql.NVarChar(500), item.rejectionReason || null)
            .input('remarks', sql.NVarChar(500), item.remarks || null)
            .query(`INSERT INTO dbo.GoodsRejectionItems (RejectionId, MaterialId, RejectedQty, UOM, RejectionReason, Remarks)
                    VALUES (@rejId, @materialId, @rejectedQty, @uom, @rejReason, @remarks)`);
        }
      }

      // Update entry status to Rejected
      const statusReq = new sql.Request(transaction);
      await statusReq
        .input('entryId', sql.Int, entry.EntryId)
        .input('versionNo', sql.Int, entry.VersionNo)
        .query(`UPDATE dbo.DeliveryEntries SET Status = 'Rejected', VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId AND VersionNo = @versionNo`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'GoodsRejection', entityId: rejection.RejectionId, action: 'Create',
        userId: req.user.userId, newValues: { rejNo, entryNo, rejectionReason },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: entry.Status, toStatus: 'Rejected', changedBy: req.user.userId,
        remarks: `Rejection note ${rejNo} created: ${rejectionReason}`,
      });

      res.status(201).json({ ...rejection, entryNo });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/rejections — List rejection notes ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = '1=1';
    if (search) {
      where += ' AND (gr.RejectionNo LIKE @search OR de.EntryNo LIKE @search OR s.SupplierName LIKE @search)';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT gr.RejectionId, gr.RejectionNo, gr.RejectionDate, gr.RejectionReason, gr.SupplierNotified,
             de.EntryNo, de.ConsignmentNo, s.SupplierName, u.FullName AS RejectedByName
      FROM dbo.GoodsRejectionNotes gr
      JOIN dbo.DeliveryEntries de ON de.EntryId = gr.EntryId
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      JOIN dbo.Users u ON u.UserId = gr.RejectedBy
      WHERE ${where}
      ORDER BY gr.RejectionDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);

    res.json({ data: result.recordset, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/rejections/:rejectionNo — Get detail ────
router.get('/:rejectionNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('rejNo', sql.VarChar(20), req.params.rejectionNo)
      .query(`SELECT gr.*, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo,
                     s.SupplierName, s.SupplierCode, u.FullName AS RejectedByName,
                     qi.InspectionNo, qi.OverallRemarks AS QARemarks
              FROM dbo.GoodsRejectionNotes gr
              JOIN dbo.DeliveryEntries de ON de.EntryId = gr.EntryId
              JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
              JOIN dbo.Users u ON u.UserId = gr.RejectedBy
              LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = gr.InspectionId
              WHERE gr.RejectionNo = @rejNo`);
    if (!result.recordset[0]) return res.status(404).json({ error: 'Rejection note not found' });

    const rejection = result.recordset[0];
    const items = await pool.request()
      .input('rejId', sql.Int, rejection.RejectionId)
      .query(`SELECT ri.*, m.MaterialCode, m.MaterialName
              FROM dbo.GoodsRejectionItems ri
              JOIN dbo.Materials m ON m.MaterialId = ri.MaterialId
              WHERE ri.RejectionId = @rejId`);

    res.json({ ...rejection, items: items.recordset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
