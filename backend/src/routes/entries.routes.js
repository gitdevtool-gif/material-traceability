const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');
const { getErpPool } = require('../erpDb');
const { getBusyItems, ensureMaterialForBusyItem } = require('../services/busy-receiving.service');
const { hasLinkColumns, busyPartyCode } = require('../services/entry-grn-link.service');

const router = express.Router();

// ──── Gate items ────
// Since 2026-10-21 the gate records WHAT is on the truck only: the supplier's
// Busy account and the Busy items, no quantity and no PO. The weighbridge
// (stage 2) records the ticket, the weight and the Busy PO line each item is
// delivered against — see weighbridge.routes.js. Busy items are re-read from
// Busy here, never taken from the browser. Old-style items (materialId /
// free-typed erpProductName) are still accepted on Admin edits of old
// entries, and everywhere until the add-busy-receiving-link.sql migration
// has run.

// Entries still at the gate — after weighing, the items carry weighbridge
// records and PO links, so the gate can no longer change them.
const GATE_STAGE = ['GateReceived', 'WeighbridgePending'];

/** Validates Busy items against Busy. Returns { items, problems }. */
async function resolveBusyItems(items) {
  const busyItems = (items || []).filter((it) => it.busyItemCode);
  if (busyItems.length === 0) return { items: [], problems: [] };

  const masters = await getBusyItems(await getErpPool(), [...new Set(busyItems.map((it) => parseInt(it.busyItemCode, 10)))]);
  const problems = [];
  const seen = new Set();
  const resolved = busyItems.map((it) => {
    const item = masters.get(parseInt(it.busyItemCode, 10));
    if (!item) { problems.push(`Busy item ${it.busyItemCode} not found`); return null; }
    if (seen.has(item.itemCode)) { problems.push(`"${item.itemName}" is listed twice`); return null; }
    seen.add(item.itemCode);
    const qty = it.quantity === '' || it.quantity === null || it.quantity === undefined ? null : Number(it.quantity);
    if (qty !== null && !(qty > 0)) problems.push(`Quantity for "${item.itemName}" must be more than 0`);
    return { ...item, line: null, quantity: qty, description: it.description || null };
  }).filter(Boolean);

  return { items: resolved, problems };
}

/** Plate as the weighbridge and Busy write it: upper case, single spaces. */
const cleanVehicleReg = (v) => String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();

async function insertBusyEntryItem(transaction, entryId, it) {
  const material = await ensureMaterialForBusyItem(() => new sql.Request(transaction), it);
  await new sql.Request(transaction)
    .input('entryId', sql.Int, entryId)
    .input('materialId', sql.Int, material.MaterialId)
    .input('quantity', sql.Decimal(12, 2), it.quantity)
    .input('uom', sql.VarChar(20), String(it.unitName || material.UOM || 'Units').slice(0, 20))
    .input('description', sql.NVarChar(300), it.description)
    .input('busyItemCode', sql.Int, it.itemCode)
    .input('refCode', sql.Int, it.line?.refCode || null)
    .input('poVchCode', sql.Int, it.line?.poVchCode || null)
    .input('poNo', sql.NVarChar(40), it.line?.poNo || null)
    .input('ordered', sql.Decimal(18, 3), it.line?.ordered ?? null)
    .input('pending', sql.Decimal(18, 3), it.line?.pending ?? null)
    .query(`INSERT INTO dbo.DeliveryEntryItems
              (EntryId, MaterialId, Quantity, UOM, Description, BusyItemCode, BusyPORefCode, BusyPOVchCode, BusyPONo, OrderedQty, PendingQty)
            VALUES (@entryId, @materialId, @quantity, @uom, @description, @busyItemCode, @refCode, @poVchCode, @poNo, @ordered, @pending)`);
}

/** The pre-2026-10-17 item path: existing material, or find/create by typed name. */
async function insertLegacyEntryItem(transaction, entryId, item) {
  let materialId = item.materialId;
  if (!materialId && item.erpProductName) {
    const lookupResult = await new sql.Request(transaction)
      .input('matName', sql.NVarChar(200), item.erpProductName)
      .query(`SELECT MaterialId FROM dbo.Materials WHERE MaterialName = @matName`);
    if (lookupResult.recordset.length > 0) {
      materialId = lookupResult.recordset[0].MaterialId;
    } else {
      const code = 'ERP-' + item.erpProductName.replace(/[^A-Za-z0-9]/g, '').substring(0, 20).toUpperCase();
      const createResult = await new sql.Request(transaction)
        .input('matCode', sql.VarChar(30), code)
        .input('matName', sql.NVarChar(200), item.erpProductName)
        .input('uom', sql.VarChar(20), 'kg')
        .query(`
          MERGE dbo.Materials AS tgt
          USING (SELECT @matName AS MaterialName) AS src ON tgt.MaterialName = src.MaterialName
          WHEN MATCHED THEN UPDATE SET UpdatedAt = GETUTCDATE()
          WHEN NOT MATCHED THEN INSERT (MaterialCode, MaterialName, UOM) VALUES (@matCode, @matName, @uom)
          OUTPUT INSERTED.MaterialId;
        `);
      materialId = createResult.recordset[0].MaterialId;
    }
  }
  await new sql.Request(transaction)
    .input('entryId', sql.Int, entryId)
    .input('materialId', sql.Int, materialId)
    .input('quantity', sql.Decimal(12, 2), item.quantity ? item.quantity : null)
    .input('uom', sql.VarChar(20), 'kg')
    .input('description', sql.NVarChar(300), item.description || null)
    .query(`INSERT INTO dbo.DeliveryEntryItems (EntryId, MaterialId, Quantity, UOM, Description)
            VALUES (@entryId, @materialId, @quantity, @uom, @description)`);
}

// ──── Helper: generate next Entry No ────
async function generateEntryNo(pool, transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = transaction
    ? new sql.Request(transaction)
    : pool.request();

  // Atomic increment
  const result = await req
    .input('seqType', sql.VarChar(20), 'ENTRY')
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
  return `ENT-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── Helper: generate next Consignment No ────
async function generateConsignmentNo(pool, transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const req = transaction
    ? new sql.Request(transaction)
    : pool.request();

  const result = await req
    .input('seqType', sql.VarChar(20), 'CONSIGN')
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
  return `CON-${today}-${String(seq).padStart(4, '0')}`;
}

// ──── POST /api/entries — Create gate entry ────
router.post('/', authenticate, authorize('GateSecurity', 'Admin'), async (req, res, next) => {
  try {
    const {
      supplierId, consignmentNo, deliveryDate, deliveryTime,
      driverName, driverIdNo, driverPhone,
      purchaseOrderNo, nonPOReason, notes, items
    } = req.body;
    const vehicleRegNo = cleanVehicleReg(req.body.vehicleRegNo);

    // Validation
    if (!supplierId || !deliveryDate || !deliveryTime || !vehicleRegNo) {
      return res.status(400).json({ error: 'supplierId, deliveryDate, deliveryTime, vehicleRegNo are required' });
    }

    const pool = await getPool();

    // Busy-linked gate entry (once the migration has run): Busy supplier and
    // Busy items. The PO is linked at the weighbridge.
    const busyMode = await hasLinkColumns(pool);
    let busy = { items: [], problems: [] };
    if (busyMode) {
      const sup = (await pool.request().input('id', sql.Int, supplierId)
        .query('SELECT SupplierCode, SupplierName FROM dbo.Suppliers WHERE SupplierId = @id')).recordset[0];
      if (!sup) return res.status(400).json({ error: 'Supplier not found' });
      if (!busyPartyCode(sup.SupplierCode)) {
        return res.status(400).json({ error: `"${sup.SupplierName}" is not a Busy supplier — pick the supplier's Busy account (refresh suppliers from Busy if it was just created there).` });
      }
      if (!items || items.length === 0) return res.status(400).json({ error: 'Add at least one material that is on the truck' });
      if (items.some((it) => !it.busyItemCode)) {
        return res.status(400).json({ error: 'Pick every material from Busy\'s item list' });
      }
      busy = await resolveBusyItems(items);
      if (busy.problems.length) return res.status(400).json({ error: busy.problems[0], problems: busy.problems });
    }
    // Busy mode: PO and non-PO reason are the weighbridge's to record.
    const poNoForEntry = busyMode ? null : (purchaseOrderNo || null);
    const nonPOReasonForEntry = busyMode ? null : (nonPOReason || null);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const entryNo = await generateEntryNo(pool, transaction);
      const consignmentNoGen = consignmentNo || await generateConsignmentNo(pool, transaction);

      const insertReq = new sql.Request(transaction);
      const result = await insertReq
        .input('entryNo', sql.VarChar(20), entryNo)
        .input('supplierId', sql.Int, supplierId)
        .input('consignmentNo', sql.VarChar(50), consignmentNoGen)
        .input('deliveryDate', sql.Date, deliveryDate)
        .input('deliveryTime', sql.VarChar(8), deliveryTime)
        .input('vehicleRegNo', sql.VarChar(20), vehicleRegNo)
        .input('driverName', sql.NVarChar(100), driverName || null)
        .input('driverIdNo', sql.VarChar(30), driverIdNo || null)
        .input('driverPhone', sql.VarChar(20), driverPhone || null)
        .input('purchaseOrderNo', sql.VarChar(30), poNoForEntry)
        .input('nonPOReason', sql.NVarChar(300), nonPOReasonForEntry)
        .input('notes', sql.NVarChar(500), notes || null)
        .input('createdBy', sql.Int, req.user.userId)
        .query(`INSERT INTO dbo.DeliveryEntries
          (EntryNo, SupplierId, ConsignmentNo, DeliveryDate, DeliveryTime,
           VehicleRegNo, DriverName, DriverIdNo, DriverPhone,
           PurchaseOrderNo, NonPOReason, Notes, Status, CreatedBy)
          OUTPUT INSERTED.EntryId, INSERTED.EntryNo, INSERTED.Status, INSERTED.CreatedAt
          VALUES (@entryNo, @supplierId, @consignmentNo, @deliveryDate, @deliveryTime,
                  @vehicleRegNo, @driverName, @driverIdNo, @driverPhone,
                  @purchaseOrderNo, @nonPOReason, @notes, 'GateReceived', @createdBy)`);

      const entry = result.recordset[0];

      // Insert line items if provided
      if (busyMode) {
        for (const it of busy.items) await insertBusyEntryItem(transaction, entry.EntryId, it);
      } else if (items && items.length > 0) {
        for (const item of items) await insertLegacyEntryItem(transaction, entry.EntryId, item);
      }

      await transaction.commit();

      // Audit (outside transaction — non-blocking)
      writeAuditLog({
        entityType: 'DeliveryEntry', entityId: entry.EntryId, action: 'Create',
        userId: req.user.userId, newValues: { entryNo, supplierId, consignmentNo, vehicleRegNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: null, toStatus: 'GateReceived', changedBy: req.user.userId,
      });

      res.status(201).json(entry);
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'Duplicate entry detected' });
    }
    next(err);
  }
});

// ──── GET /api/entries — List / search entries ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, supplierId, dateFrom, dateTo, search, page = 1, limit = 50 } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = '1=1';
    if (status) {
      where += ' AND de.Status = @status';
      request.input('status', sql.VarChar(30), status);
    }
    if (supplierId) {
      where += ' AND de.SupplierId = @supplierId';
      request.input('supplierId', sql.Int, parseInt(supplierId));
    }
    if (dateFrom) {
      where += ' AND de.DeliveryDate >= @dateFrom';
      request.input('dateFrom', sql.Date, dateFrom);
    }
    if (dateTo) {
      where += ' AND de.DeliveryDate <= @dateTo';
      request.input('dateTo', sql.Date, dateTo);
    }
    if (search) {
      where += ` AND (de.EntryNo LIKE @search OR de.ConsignmentNo LIKE @search OR de.VehicleRegNo LIKE @search OR s.SupplierName LIKE @search
                 OR de.DriverName LIKE @search OR de.PurchaseOrderNo LIKE @search
                 OR EXISTS (SELECT 1 FROM dbo.DeliveryEntryItems si JOIN dbo.Materials sm ON sm.MaterialId = si.MaterialId
                            WHERE si.EntryId = de.EntryId AND sm.MaterialName LIKE @search))`;
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT de.EntryId, de.EntryNo, de.ConsignmentNo, de.DeliveryDate, de.DeliveryTime,
             de.VehicleRegNo, de.DriverName, de.DriverIdNo, de.DriverPhone,
             de.FirstWeight, de.SecondWeight, de.NetWeight,
             de.PurchaseOrderNo, de.Status, de.CreatedAt,
             s.SupplierId, s.SupplierCode, s.SupplierName,
             u.FullName AS CreatedByName
      FROM dbo.DeliveryEntries de
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      JOIN dbo.Users u ON u.UserId = de.CreatedBy
      WHERE ${where}
      ORDER BY de.CreatedAt DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    // Total count (properly parameterized)
    const countReq = pool.request();
    if (status) { countReq.input('status', sql.VarChar(30), status); }
    if (supplierId) { countReq.input('supplierId', sql.Int, parseInt(supplierId)); }
    if (dateFrom) { countReq.input('dateFrom', sql.Date, dateFrom); }
    if (dateTo) { countReq.input('dateTo', sql.Date, dateTo); }
    if (search) { countReq.input('search', sql.NVarChar(100), `%${search}%`); }
    const countResult = await countReq.query(
      `SELECT COUNT(*) as total FROM dbo.DeliveryEntries de
       JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
       WHERE ${where}`
    );

    res.json({
      data: result.recordset,
      total: countResult.recordset[0].total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/entries/:entryNo — Get single entry by EntryNo ────
router.get('/:entryNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query(`
        SELECT de.*, s.SupplierCode, s.SupplierName, u.FullName AS CreatedByName
        FROM dbo.DeliveryEntries de
        JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
        JOIN dbo.Users u ON u.UserId = de.CreatedBy
        WHERE de.EntryNo = @entryNo
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const entry = result.recordset[0];

    // Fetch child data in parallel
    const [items, wb, grn, qa] = await Promise.all([
      pool.request()
        .input('entryId', sql.Int, entry.EntryId)
        .query(`SELECT dei.*, m.MaterialCode, m.MaterialName
                FROM dbo.DeliveryEntryItems dei
                JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
                WHERE dei.EntryId = @entryId`),
      pool.request()
        .input('entryId2', sql.Int, entry.EntryId)
        .query(`SELECT wr.*, u.FullName AS OperatorName
                FROM dbo.WeighbridgeRecords wr
                JOIN dbo.Users u ON u.UserId = wr.OperatorId
                WHERE wr.EntryId = @entryId2`),
      pool.request()
        .input('entryId3', sql.Int, entry.EntryId)
        .query(`SELECT g.*, u.FullName AS ReceivedByName, sl.LocationName
                FROM dbo.GoodsReceiptNotes g
                JOIN dbo.Users u ON u.UserId = g.ReceivedBy
                LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
                WHERE g.EntryId = @entryId3`),
      pool.request()
        .input('entryId4', sql.Int, entry.EntryId)
        // TOP 1 ... ORDER BY InspectionId DESC — an entry rejected once by
        // the Ops Manager and re-inspected can have more than one row
        // here; the caller below takes recordset[0] as THE inspection for
        // this entry, so it must always be the latest one, not whichever
        // row the server happens to return first.
        .query(`SELECT TOP 1 qi.InspectionNo, qi.OverallStatus, qi.AcceptedQty, qi.RejectedQty,
                       qi.OverallRemarks, qi.InspectionDate, qi.ApprovedAt,
                       u.FullName AS InspectorName, ua.FullName AS ApprovedByName
                FROM dbo.QAInspections qi
                JOIN dbo.Users u ON u.UserId = qi.InspectorId
                LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
                WHERE qi.EntryId = @entryId4
                ORDER BY qi.InspectionId DESC`),
    ]);

    res.json({
      ...entry,
      items: items.recordset,
      weighbridge: wb.recordset[0] || null,
      grn: grn.recordset[0] || null,
      qaInspection: qa.recordset[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

// ──── PUT /api/entries/:entryNo — Edit gate entry (Admin only) ────
router.put('/:entryNo', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const {
      supplierId, consignmentNo, deliveryDate, deliveryTime,
      driverName, driverIdNo, driverPhone,
      notes, items
    } = req.body;
    const vehicleRegNo = cleanVehicleReg(req.body.vehicleRegNo);

    if (!supplierId || !deliveryDate || !deliveryTime || !vehicleRegNo) {
      return res.status(400).json({ error: 'supplierId, deliveryDate, deliveryTime, vehicleRegNo are required' });
    }

    const pool = await getPool();

    // Fetch current entry
    const current = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query('SELECT EntryId, Status, VersionNo FROM dbo.DeliveryEntries WHERE EntryNo = @entryNo');

    if (!current.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    const entry = current.recordset[0];

    // Once weighed, the items carry weighbridge records and PO links: only
    // the delivery details can still be corrected here.
    const replaceItems = GATE_STAGE.includes(entry.Status);
    if (replaceItems && (!items || items.length === 0)) {
      return res.status(400).json({ error: 'Add at least one material that is on the truck' });
    }

    // Busy items are re-validated against Busy; old-style items on old
    // entries are kept as they are.
    let busy = { items: [], problems: [] };
    if (replaceItems && await hasLinkColumns(pool) && items.some((it) => it.busyItemCode)) {
      busy = await resolveBusyItems(items);
      if (busy.problems.length) return res.status(400).json({ error: busy.problems[0], problems: busy.problems });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const updateReq = new sql.Request(transaction);
      await updateReq
        .input('entryId', sql.Int, entry.EntryId)
        .input('supplierId', sql.Int, supplierId)
        .input('consignmentNo', sql.VarChar(50), consignmentNo || null)
        .input('deliveryDate', sql.Date, deliveryDate)
        .input('deliveryTime', sql.VarChar(8), deliveryTime)
        .input('vehicleRegNo', sql.VarChar(20), vehicleRegNo)
        .input('driverName', sql.NVarChar(100), driverName || null)
        .input('driverIdNo', sql.VarChar(30), driverIdNo || null)
        .input('driverPhone', sql.VarChar(20), driverPhone || null)
        .input('notes', sql.NVarChar(500), notes || null)
        .input('versionNo', sql.Int, entry.VersionNo)
        // PurchaseOrderNo / NonPOReason belong to the weighbridge — not touched here.
        .query(`UPDATE dbo.DeliveryEntries
                SET SupplierId = @supplierId, ConsignmentNo = ISNULL(@consignmentNo, ConsignmentNo),
                    DeliveryDate = @deliveryDate, DeliveryTime = @deliveryTime,
                    VehicleRegNo = @vehicleRegNo, DriverName = @driverName, DriverIdNo = @driverIdNo, DriverPhone = @driverPhone,
                    Notes = @notes,
                    VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId AND VersionNo = @versionNo`);

      if (replaceItems) {
        await new sql.Request(transaction)
          .input('entryId', sql.Int, entry.EntryId)
          .query('DELETE FROM dbo.DeliveryEntryItems WHERE EntryId = @entryId');

        for (const it of busy.items) await insertBusyEntryItem(transaction, entry.EntryId, it);
        for (const item of items.filter((it) => !it.busyItemCode)) {
          await insertLegacyEntryItem(transaction, entry.EntryId, item);
        }
      }

      await transaction.commit();

      writeAuditLog({
        entityType: 'DeliveryEntry', entityId: entry.EntryId, action: 'Update',
        userId: req.user.userId, newValues: { supplierId, consignmentNo, vehicleRegNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });

      res.json({
        entryNo: req.params.entryNo,
        message: replaceItems ? 'Entry updated' : 'Delivery details updated (items were already weighed and are kept as they are)',
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── DELETE /api/entries/:entryNo — Delete gate entry (Admin only) ────
router.delete('/:entryNo', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const pool = await getPool();

    const current = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query('SELECT EntryId, Status FROM dbo.DeliveryEntries WHERE EntryNo = @entryNo');

    if (!current.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    const entry = current.recordset[0];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Cascade delete all child records in FK-safe order

      // 1. GoodsRejectionItems (child of GoodsRejectionNotes)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query(`DELETE FROM dbo.GoodsRejectionItems
                WHERE RejectionId IN (SELECT RejectionId FROM dbo.GoodsRejectionNotes WHERE EntryId = @entryId)`);

      // 2. GoodsRejectionNotes (FK → EntryId, InspectionId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.GoodsRejectionNotes WHERE EntryId = @entryId');

      // 3. QATestResults (child of QAInspections)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query(`DELETE FROM dbo.QATestResults
                WHERE InspectionId IN (SELECT InspectionId FROM dbo.QAInspections WHERE EntryId = @entryId)`);

      // 4. QAInspections (FK → EntryId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.QAInspections WHERE EntryId = @entryId');

      // 5. GRNItems (child of GoodsReceiptNotes)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query(`DELETE FROM dbo.GRNItems
                WHERE GRNId IN (SELECT GRNId FROM dbo.GoodsReceiptNotes WHERE EntryId = @entryId)`);

      // 6. GoodsReceiptNotes (FK → EntryId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.GoodsReceiptNotes WHERE EntryId = @entryId');

      // 7. WeighbridgeRecords (FK → EntryId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.WeighbridgeRecords WHERE EntryId = @entryId');

      // 8. StatusHistory (polymorphic, no FK but clean up)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query(`DELETE FROM dbo.StatusHistory WHERE EntityType = 'DeliveryEntry' AND EntityId = @entryId`);

      // 9. ApprovalTokens (FK → EntryId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.ApprovalTokens WHERE EntryId = @entryId');

      // 10. DeliveryEntryItems (FK → EntryId)
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.DeliveryEntryItems WHERE EntryId = @entryId');

      // 10. DeliveryEntries
      await new sql.Request(transaction)
        .input('entryId', sql.Int, entry.EntryId)
        .query('DELETE FROM dbo.DeliveryEntries WHERE EntryId = @entryId');

      await transaction.commit();

      writeAuditLog({
        entityType: 'DeliveryEntry', entityId: entry.EntryId, action: 'Delete',
        userId: req.user.userId, newValues: { entryNo: req.params.entryNo },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });

      res.json({ message: 'Entry deleted' });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── PATCH /api/entries/:entryNo/status — Update entry status ────
router.patch('/:entryNo/status', authenticate, authorize('GateSecurity', 'Weighbridge', 'Supervisor', 'Admin'), async (req, res, next) => {
  try {
    const { status, remarks } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const pool = await getPool();
    const current = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query('SELECT EntryId, Status, VersionNo FROM dbo.DeliveryEntries WHERE EntryNo = @entryNo');

    if (!current.recordset[0]) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const entry = current.recordset[0];

    // Validate valid transitions
    const validTransitions = {
      'GateReceived': ['WeighbridgePending', 'Cancelled'],
      'WeighbridgePending': ['WeighbridgeCompleted', 'Cancelled'],
      'WeighbridgeCompleted': ['QAPending', 'RoutingPending', 'Cancelled'],
      'CentralStoreReceived': ['GRNCreated', 'Cancelled'],
      'QAPending': ['QAInProgress', 'QAAccepted', 'QARejected', 'Quarantine', 'Cancelled'],
      'QAInProgress': ['QAAccepted', 'QARejected', 'Quarantine'],
      'Quarantine': ['QAAccepted', 'QARejected', 'Cancelled'],
      'QAAccepted': ['RoutingPending', 'GRNCreated'],
      'QARejected': ['Rejected', 'Cancelled'],
      'RoutingPending': ['GRNCreated', 'Cancelled'],
      'GRNCreated': ['Closed'],
    };

    const allowed = validTransitions[entry.Status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${entry.Status} to ${status}` });
    }

    await pool.request()
      .input('entryId', sql.Int, entry.EntryId)
      .input('status', sql.VarChar(30), status)
      .input('versionNo', sql.Int, entry.VersionNo)
      .query(`UPDATE dbo.DeliveryEntries
              SET Status = @status, VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
              WHERE EntryId = @entryId AND VersionNo = @versionNo`);

    writeStatusHistory({
      entityType: 'DeliveryEntry', entityId: entry.EntryId,
      fromStatus: entry.Status, toStatus: status, changedBy: req.user.userId, remarks,
    });

    res.json({ entryNo: req.params.entryNo, status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
