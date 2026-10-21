const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool, sql: erpSql } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');

const router = express.Router();

// ──── Helper: generate next GRN No ────
async function generateGRNNo(transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = new sql.Request(transaction);

  const result = await req
    .input('seqType', sql.VarChar(20), 'GRN')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN
        UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN
        INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);

  const seq = result.recordset[0].LastNumber;
  return `GRN-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── Helper: generate Batch No ────
async function generateBatchNo(transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = new sql.Request(transaction);

  const result = await req
    .input('seqType', sql.VarChar(20), 'BATCH')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN
        UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN
        INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);

  const seq = result.recordset[0].LastNumber;
  return `BAT-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── POST /api/grn — Create GRN ────
router.post('/', authenticate, authorize('StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'Admin'), async (req, res, next) => {
  try {
    const { entryNo, receivingDept, notes, items, erpVchNo, purchaseOrderNo, nonPOReason } = req.body;

    if (!entryNo || !receivingDept) {
      return res.status(400).json({ error: 'entryNo and receivingDept are required' });
    }
    if (!['Factory', 'CentralStore'].includes(receivingDept)) {
      return res.status(400).json({ error: 'receivingDept must be Factory or CentralStore' });
    }

    const pool = await getPool();

    // Fetch entry and validate status
    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query('SELECT EntryId, Status, VersionNo, LocationId FROM dbo.DeliveryEntries WHERE EntryNo = @entryNo');

    if (!entryResult.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    const entry = entryResult.recordset[0];

    // Use locationId from the entry (set at weighbridge stage)
    const locationId = entry.LocationId || null;

    if (!['OpsManagerApproved', 'QAAccepted', 'CentralStoreReceived', 'WeighbridgeCompleted', 'RoutingPending'].includes(entry.Status)) {
      return res.status(400).json({ error: `Cannot create GRN — entry status is ${entry.Status}. Must be OpsManagerApproved, QAAccepted, CentralStoreReceived, WeighbridgeCompleted or RoutingPending.` });
    }

    // Check no existing GRN
    const existingGRN = await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .query("SELECT GRNId FROM dbo.GoodsReceiptNotes WHERE EntryId = @entryId AND GRNStatus != 'Reversed'");

    if (existingGRN.recordset.length > 0) {
      return res.status(409).json({ error: 'An active GRN already exists for this entry' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Use ERP voucher number as GRN number if provided, otherwise auto-generate
      const grnNo = erpVchNo ? erpVchNo.trim() : await generateGRNNo(transaction);
      const batchNo = await generateBatchNo(transaction);

      const grnReq = new sql.Request(transaction);
      const grnResult = await grnReq
        .input('grnNo', sql.VarChar(50), grnNo)
        .input('batchNo', sql.VarChar(30), batchNo)
        .input('entryId', sql.Int, entry.EntryId)
        .input('receivingDept', sql.VarChar(30), receivingDept)
        .input('locationId', sql.Int, locationId || null)
        .input('receivedBy', sql.Int, req.user.userId)
        .input('notes', sql.NVarChar(500), notes || null)
        .query(`INSERT INTO dbo.GoodsReceiptNotes
          (GRNNo, BatchNo, EntryId, ReceivingDept, LocationId, GRNStatus, ReceivedBy, Notes)
          OUTPUT INSERTED.GRNId, INSERTED.GRNNo, INSERTED.BatchNo, INSERTED.GRNStatus, INSERTED.ReceivedAt
          VALUES (@grnNo, @batchNo, @entryId, @receivingDept, @locationId, 'Created', @receivedBy, @notes)`);

      const grn = grnResult.recordset[0];

      // Insert GRN items
      if (items && items.length > 0) {
        for (const item of items) {
          const itemReq = new sql.Request(transaction);
          await itemReq
            .input('grnId', sql.Int, grn.GRNId)
            .input('materialId', sql.Int, item.materialId)
            .input('expectedQty', sql.Decimal(12, 2), item.expectedQty)
            .input('receivedQty', sql.Decimal(12, 2), item.receivedQty)
            .input('acceptedQty', sql.Decimal(12, 2), item.acceptedQty)
            .input('rejectedQty', sql.Decimal(12, 2), item.rejectedQty || 0)
            .input('rejectionReason', sql.NVarChar(500), item.rejectionReason || null)
            .input('uom', sql.VarChar(20), item.uom)
            .input('remarks', sql.NVarChar(500), item.remarks || null)
            .query(`INSERT INTO dbo.GRNItems
              (GRNId, MaterialId, ExpectedQty, ReceivedQty, AcceptedQty, RejectedQty, RejectionReason, UOM, Remarks)
              VALUES (@grnId, @materialId, @expectedQty, @receivedQty, @acceptedQty, @rejectedQty, @rejectionReason, @uom, @remarks)`);
        }
      }

      // Update entry status to GRNCreated and save PO fields
      const statusReq = new sql.Request(transaction);
      await statusReq
        .input('entryId', sql.Int, entry.EntryId)
        .input('versionNo', sql.Int, entry.VersionNo)
        .input('purchaseOrderNo', sql.VarChar(30), purchaseOrderNo || null)
        .input('nonPOReason', sql.NVarChar(300), nonPOReason || null)
        .query(`UPDATE dbo.DeliveryEntries
                SET Status = 'GRNCreated', PurchaseOrderNo = @purchaseOrderNo, NonPOReason = @nonPOReason, VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId AND VersionNo = @versionNo`);

      await transaction.commit();

      // Audit
      writeAuditLog({
        entityType: 'GRN', entityId: grn.GRNId, action: 'Create',
        userId: req.user.userId, newValues: { grnNo, entryNo, receivingDept },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: entry.Status, toStatus: 'GRNCreated',
        changedBy: req.user.userId, remarks: `GRN ${grnNo} created`,
      });
      writeStatusHistory({
        entityType: 'GRN', entityId: grn.GRNId,
        fromStatus: null, toStatus: 'Created', changedBy: req.user.userId,
      });

      res.status(201).json({ ...grn, entryNo, receivingDept });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'GRN already exists for this entry' });
    }
    next(err);
  }
});

// ──── POST /api/grn/:grnNo/reverse — Reverse a GRN ────
router.post('/:grnNo/reverse', authenticate, authorize('Supervisor', 'Admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Reversal reason is required' });
    }

    const pool = await getPool();
    const grnResult = await pool.request()
      .input('grnNo', sql.VarChar(20), req.params.grnNo)
      .query("SELECT GRNId, EntryId, GRNStatus, VersionNo FROM dbo.GoodsReceiptNotes WHERE GRNNo = @grnNo AND GRNStatus != 'Reversed'");

    if (!grnResult.recordset[0]) {
      return res.status(404).json({ error: 'Active GRN not found' });
    }
    const grn = grnResult.recordset[0];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Mark GRN as reversed
      const revReq = new sql.Request(transaction);
      await revReq
        .input('grnId', sql.Int, grn.GRNId)
        .input('reason', sql.NVarChar(500), reason)
        .input('reversedBy', sql.Int, req.user.userId)
        .input('versionNo', sql.Int, grn.VersionNo)
        .query(`UPDATE dbo.GoodsReceiptNotes
                SET GRNStatus = 'Reversed', ReversalReason = @reason, ReversedBy = @reversedBy,
                    ReversedAt = GETUTCDATE(), VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE GRNId = @grnId AND VersionNo = @versionNo`);

      // Revert delivery entry status to WeighbridgeCompleted so a new GRN can be created
      // First drop the unique constraint record by updating entry
      const entryReq = new sql.Request(transaction);
      await entryReq
        .input('entryId', sql.Int, grn.EntryId)
        .query(`UPDATE dbo.DeliveryEntries
                SET Status = 'WeighbridgeCompleted', VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'GRN', entityId: grn.GRNId, action: 'Reverse',
        userId: req.user.userId, oldValues: { status: grn.GRNStatus }, newValues: { status: 'Reversed', reason },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'GRN', entityId: grn.GRNId,
        fromStatus: grn.GRNStatus, toStatus: 'Reversed',
        changedBy: req.user.userId, remarks: reason,
      });

      res.json({ grnNo: req.params.grnNo, status: 'Reversed' });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/grn — List GRNs ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, receivingDept, dateFrom, dateTo, search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = '1=1';
    if (status) { where += ' AND g.GRNStatus = @status'; request.input('status', sql.VarChar(30), status); }
    if (receivingDept) { where += ' AND g.ReceivingDept = @dept'; request.input('dept', sql.VarChar(30), receivingDept); }
    if (dateFrom) { where += ' AND g.ReceivedAt >= @dateFrom'; request.input('dateFrom', sql.Date, dateFrom); }
    if (dateTo) { where += ' AND g.ReceivedAt < DATEADD(day, 1, @dateTo)'; request.input('dateTo', sql.Date, dateTo); }
    if (search) {
      where += ' AND (g.GRNNo LIKE @search OR de.EntryNo LIKE @search OR s.SupplierName LIKE @search)';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT g.GRNId, g.GRNNo, g.ReceivingDept, g.GRNStatus, g.ReceivedAt, g.Notes,
             de.EntryNo, de.ConsignmentNo, de.VehicleRegNo,
             s.SupplierName, s.SupplierCode,
             u.FullName AS ReceivedByName,
             sl.LocationName
      FROM dbo.GoodsReceiptNotes g
      JOIN dbo.DeliveryEntries de ON de.EntryId = g.EntryId
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      JOIN dbo.Users u ON u.UserId = g.ReceivedBy
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
      WHERE ${where}
      ORDER BY g.ReceivedAt DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json({ data: result.recordset, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/grn/:grnNo — Get GRN detail ────
router.get('/:grnNo(*)', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('grnNo', sql.VarChar(50), decodeURIComponent(req.params.grnNo))
      .query(`
        SELECT g.*, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.PurchaseOrderNo,
               de.DriverName, de.DriverPhone, de.DeliveryDate,
               s.SupplierName, s.SupplierCode,
               u.FullName AS ReceivedByName,
               sl.LocationName,
               wr.TicketNo AS WBTicketNo, wr.FirstWeight, wr.SecondWeight, wr.NetWeight AS WBNetWeight,
               qi.AcceptedQty AS QAAcceptedQty, qi.RejectedQty AS QARejectedQty
        FROM dbo.GoodsReceiptNotes g
        JOIN dbo.DeliveryEntries de ON de.EntryId = g.EntryId
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        JOIN dbo.Users u ON u.UserId = g.ReceivedBy
        LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
        LEFT JOIN dbo.WeighbridgeRecords wr ON wr.EntryId = g.EntryId
        LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = (
          -- Latest inspection for this entry — an entry rejected once by
          -- the Ops Manager and re-inspected can have more than one row;
          -- a GRN only ever exists once the FINAL (accepted) one led to
          -- OpsManagerApproved, so "latest" is always the right one here.
          SELECT TOP 1 qi2.InspectionId FROM dbo.QAInspections qi2
          WHERE qi2.EntryId = g.EntryId ORDER BY qi2.InspectionId DESC
        )
        WHERE g.GRNNo = @grnNo
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'GRN not found' });
    }

    const grn = result.recordset[0];

    const itemsResult = await pool.request()
      .input('grnId', sql.Int, grn.GRNId)
      .input('entryId', sql.Int, grn.EntryId)
      .query(`SELECT gi.*, m.MaterialCode, m.MaterialName,
                     moisture.ActualValue AS Moisture,
                     waste.ActualValue AS Waste,
                     qi.OverallRemarks AS QARemarks
              FROM dbo.GRNItems gi
              JOIN dbo.Materials m ON m.MaterialId = gi.MaterialId
              LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = (
                SELECT TOP 1 qi2.InspectionId FROM dbo.QAInspections qi2
                WHERE qi2.EntryId = @entryId ORDER BY qi2.InspectionId DESC
              )
              LEFT JOIN dbo.QATestResults moisture
                ON moisture.InspectionId = qi.InspectionId
                AND moisture.MaterialId = gi.MaterialId
                AND moisture.TestName LIKE '%moisture%'
              LEFT JOIN dbo.QATestResults waste
                ON waste.InspectionId = qi.InspectionId
                AND waste.MaterialId = gi.MaterialId
                AND waste.TestName LIKE '%waste%'
              WHERE gi.GRNId = @grnId`);

    // Fetch ERP Amount data if GRN number is an ERP VchNo (e.g. Grv-XXXX/YYYY-YY)
    let items = itemsResult.recordset;
    if (grn.GRNNo && grn.GRNNo.toLowerCase().startsWith('grv')) {
      try {
        const erpPool = await getErpPool();
        const erpResult = await erpPool.request()
          .input('vchNo', erpSql.NVarChar(50), grn.GRNNo)
          .query(`SELECT gr.Name, gr.Qty, gr.Price, gr.Amount
                  FROM dbo.GoodsReceived gr
                  WHERE LTRIM(RTRIM(gr.VchNo)) = @vchNo`);
        const erpRows = erpResult.recordset;
        // Match ERP rows to GRN items by material name
        items = items.map(item => {
          const match = erpRows.find(e =>
            item.MaterialName && e.Name &&
            (e.Name.toLowerCase().includes(item.MaterialName.toLowerCase()) ||
             item.MaterialName.toLowerCase().includes(e.Name.toLowerCase()))
          );
          return { ...item, ErpPrice: match?.Price || null, ErpAmount: match?.Amount || null };
        });
      } catch (_) { /* ERP unavailable — continue without amount */ }
    }

    res.json({ ...grn, items });
  } catch (err) {
    next(err);
  }
});

// ──── DELETE /api/grn/:grnNo — Delete GRN (Admin only) ────
router.delete('/:grnNo(*)', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('grnNo', sql.VarChar(50), decodeURIComponent(req.params.grnNo))
      .query(`SELECT g.GRNId, g.EntryId, g.GRNStatus, de.Status AS EntryStatus
              FROM dbo.GoodsReceiptNotes g
              JOIN dbo.DeliveryEntries de ON de.EntryId = g.EntryId
              WHERE g.GRNNo = @grnNo`);

    if (!result.recordset[0]) return res.status(404).json({ error: 'GRN not found' });
    const grn = result.recordset[0];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // 1. Clear ReversalOf references pointing to this GRN
      await new sql.Request(transaction)
        .input('grnId', sql.Int, grn.GRNId)
        .query('UPDATE dbo.GoodsReceiptNotes SET ReversalOf = NULL WHERE ReversalOf = @grnId');

      // 2. Delete GRNItems
      await new sql.Request(transaction)
        .input('grnId', sql.Int, grn.GRNId)
        .query('DELETE FROM dbo.GRNItems WHERE GRNId = @grnId');

      // 3. Delete GRN
      await new sql.Request(transaction)
        .input('grnId', sql.Int, grn.GRNId)
        .query('DELETE FROM dbo.GoodsReceiptNotes WHERE GRNId = @grnId');

      // 4. Reset entry status back to OpsManagerApproved so it can be re-received
      await new sql.Request(transaction)
        .input('entryId', sql.Int, grn.EntryId)
        .query(`UPDATE dbo.DeliveryEntries SET Status = 'OpsManagerApproved', VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId`);

      await transaction.commit();

      writeAuditLog({
        entityType: 'GRN', entityId: grn.GRNId, action: 'Delete',
        userId: req.user.userId, newValues: { grnNo: req.params.grnNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });

      res.json({ message: 'GRN deleted', grnNo: req.params.grnNo });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
