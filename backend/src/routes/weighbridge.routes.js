const express = require('express');
const { getPool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');
const { getErpPool } = require('../erpDb');
const { getOpenPoLines } = require('../services/busy-receiving.service');
const { hasLinkColumns, busyPartyCode } = require('../services/entry-grn-link.service');

const router = express.Router();

// Stage 2 of a delivery (2026-10-21): the gate only records what is on the
// truck; the weighbridge records the ticket, the weights and — per item —
// the Busy PO line it is delivered against (or why it is not on a PO).

const WEIGHABLE = ['GateReceived', 'WeighbridgePending'];

/** Weighed kg as a quantity in the item's own unit, where that is plain arithmetic. */
function qtyFromWeight(uom, kg) {
  const u = String(uom || '').trim().toLowerCase().replace(/\./g, '');
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(u)) return kg;
  if (/^(ton|tons|tonne|tonnes|mt)$/.test(u)) return Math.round(kg) / 1000;
  return null;
}

/**
 * Checks the PO lines chosen at the weighbridge against Busy: still pending,
 * this supplier's, the same item. Returns { lineByItem, problems }.
 */
async function resolvePoLinks(entryItems, items, supplierCode) {
  const problems = [];
  const lineByItem = new Map();
  const wanted = items.filter((it) => it.busyPORefCode);
  if (wanted.length === 0) return { lineByItem, problems };

  const party = busyPartyCode(supplierCode);
  if (!party) return { lineByItem, problems: ['This supplier is not a Busy supplier, so its items cannot be linked to a Busy PO'] };

  const refCodes = [...new Set(wanted.map((it) => parseInt(it.busyPORefCode, 10)).filter(Boolean))];
  const lines = await getOpenPoLines(await getErpPool(), { refCodes });
  const byRef = new Map(lines.map((l) => [l.refCode, l]));
  for (const it of wanted) {
    const ei = entryItems.get(Number(it.entryItemId));
    const line = byRef.get(parseInt(it.busyPORefCode, 10));
    if (!line) problems.push(`The PO line chosen for "${ei.MaterialName}" is no longer pending in Busy — refresh and choose again`);
    else if (line.partyCode !== party) problems.push(`${line.poNo} is not for this supplier`);
    else if (ei.BusyItemCode && line.itemCode !== ei.BusyItemCode) problems.push(`${line.poNo} line is for "${line.itemName}", not "${ei.MaterialName}"`);
    else lineByItem.set(Number(it.entryItemId), line);
  }
  return { lineByItem, problems };
}

// ──── POST /api/weighbridge — Record weighbridge data (per-item) ────
router.post('/', authenticate, authorize('Weighbridge', 'Admin'), async (req, res, next) => {
  try {
    const { entryNo, destination, locationId, skipQA, items } = req.body;
    const ticketNo = String(req.body.ticketNo || '').trim();
    const nonPOReason = String(req.body.nonPOReason || '').trim();

    if (!entryNo) return res.status(400).json({ error: 'entryNo is required' });
    if (!ticketNo) return res.status(400).json({ error: 'Enter the weighbridge ticket number' });
    if (!destination || !['Factory', 'CentralStore'].includes(destination)) {
      return res.status(400).json({ error: 'destination is required (Factory or CentralStore)' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required (one entry per raw material)' });
    }
    for (const it of items) {
      if (it.firstWeight == null || it.secondWeight == null || it.netWeight == null) {
        return res.status(400).json({ error: 'Each item requires firstWeight, secondWeight and netWeight' });
      }
    }

    const pool = await getPool();

    const entryResult = await pool.request()
      .input('entryNo', sql.VarChar(20), entryNo)
      .query(`SELECT de.EntryId, de.Status, de.VersionNo, s.SupplierCode
              FROM dbo.DeliveryEntries de JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
              WHERE de.EntryNo = @entryNo`);

    if (!entryResult.recordset[0]) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.recordset[0];

    if (!WEIGHABLE.includes(entry.Status)) {
      return res.status(409).json({ error: `${entryNo} has already been weighed (status ${entry.Status})` });
    }

    const linkCols = await hasLinkColumns(pool);
    const entryItems = new Map((await pool.request().input('id', sql.Int, entry.EntryId).query(`
      SELECT dei.EntryItemId, dei.Quantity, dei.UOM, m.MaterialName,
             ${linkCols ? 'dei.BusyItemCode' : 'NULL AS BusyItemCode'}
      FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
      WHERE dei.EntryId = @id`)).recordset.map((r) => [Number(r.EntryItemId), r]));

    if (entryItems.size > 0 && items.some((it) => !entryItems.has(Number(it.entryItemId)))) {
      return res.status(400).json({ error: 'An item does not belong to this entry — reload the entry and weigh again' });
    }

    // One ticket belongs to one truck.
    const dup = (await pool.request()
      .input('ticketNo', sql.VarChar(50), ticketNo)
      .input('id', sql.Int, entry.EntryId)
      .query(`SELECT TOP 1 de.EntryNo FROM dbo.WeighbridgeRecords wr JOIN dbo.DeliveryEntries de ON de.EntryId = wr.EntryId
              WHERE wr.TicketNo = @ticketNo AND wr.EntryId <> @id`)).recordset[0];
    if (dup) return res.status(409).json({ error: `Ticket ${ticketNo} is already recorded on ${dup.EntryNo}` });

    let links = { lineByItem: new Map(), problems: [] };
    if (linkCols) {
      links = await resolvePoLinks(entryItems, items, entry.SupplierCode);
      if (links.problems.length) return res.status(400).json({ error: links.problems[0], problems: links.problems });
      const offPo = items.filter((it) => !links.lineByItem.has(Number(it.entryItemId)) && entryItems.get(Number(it.entryItemId))?.BusyItemCode);
      if (offPo.length && busyPartyCode(entry.SupplierCode) && !nonPOReason) {
        return res.status(400).json({ error: 'Some items are not on a Busy PO — give the reason (Procurement must raise the PO before Stores can receive them in Busy)' });
      }
    }
    const poNos = [...new Set([...links.lineByItem.values()].map((l) => l.poNo))];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      let totalNet = 0;
      const wbIds = [];

      for (const it of items) {
        const finalNetWeight = parseFloat(it.finalNetWeight) || parseFloat(it.netWeight);
        const bagWeight = it.deductBagWeight ? (parseFloat(it.bagWeight) || 0) : null;

        const wbReq = new sql.Request(transaction);
        const wbResult = await wbReq
          .input('entryId',        sql.Int,           entry.EntryId)
          .input('entryItemId',    sql.BigInt,        it.entryItemId || null)
          .input('ticketNo',       sql.VarChar(50),   ticketNo)
          .input('firstWeight',    sql.Decimal(10,2), it.firstWeight)
          .input('secondWeight',   sql.Decimal(10,2), it.secondWeight)
          .input('netWeight',      sql.Decimal(10,2), it.netWeight)
          .input('bagWeight',      sql.Decimal(10,2), bagWeight)
          .input('finalNetWeight', sql.Decimal(10,2), finalNetWeight)
          .input('operatorId',     sql.Int,           req.user.userId)
          .input('remarks',        sql.NVarChar(500), it.remarks || null)
          .query(`INSERT INTO dbo.WeighbridgeRecords
            (EntryId, EntryItemId, TicketNo, FirstWeight, SecondWeight, NetWeight,
             BagWeight, FinalNetWeight, WeightVariance, OperatorId, Remarks)
            OUTPUT INSERTED.WeighbridgeId
            VALUES (@entryId, @entryItemId, @ticketNo, @firstWeight, @secondWeight, @netWeight,
                    @bagWeight, @finalNetWeight, 0, @operatorId, @remarks)`);

        wbIds.push(wbResult.recordset[0].WeighbridgeId);
        // Sum finalNetWeight so DeliveryEntries.NetWeight reflects true deducted weight
        totalNet += finalNetWeight;

        // The item's PO line, and its quantity from the weight where the unit allows.
        const ei = entryItems.get(Number(it.entryItemId));
        if (ei) {
          const line = links.lineByItem.get(Number(it.entryItemId)) || null;
          const itemReq = new sql.Request(transaction)
            .input('entryItemId', sql.BigInt, ei.EntryItemId)
            .input('quantity', sql.Decimal(12, 2), ei.Quantity ?? qtyFromWeight(ei.UOM, finalNetWeight));
          if (linkCols) {
            itemReq
              .input('refCode', sql.Int, line?.refCode || null)
              .input('poVchCode', sql.Int, line?.poVchCode || null)
              .input('poNo', sql.NVarChar(40), line?.poNo || null)
              .input('ordered', sql.Decimal(18, 3), line?.ordered ?? null)
              .input('pending', sql.Decimal(18, 3), line?.pending ?? null);
          }
          await itemReq.query(`UPDATE dbo.DeliveryEntryItems SET Quantity = @quantity
            ${linkCols ? `, BusyPORefCode = @refCode, BusyPOVchCode = @poVchCode, BusyPONo = @poNo,
                          OrderedQty = @ordered, PendingQty = @pending` : ''}
            WHERE EntryItemId = @entryItemId`);
        }
      }

      // Determine next status
      let nextStatus;
      if (destination === 'Factory') {
        nextStatus = skipQA ? 'OpsManagerApproved' : 'WeighbridgeCompleted';
      } else {
        nextStatus = 'CentralStoreReceived';
      }

      const updateReq = new sql.Request(transaction);
      const updated = await updateReq
        .input('entryId',     sql.Int,           entry.EntryId)
        .input('netWeight',   sql.Decimal(10,2), totalNet)
        .input('destination', sql.VarChar(20),   destination)
        .input('locationId',  sql.Int,           locationId || null)
        .input('skipQA',      sql.Bit,           skipQA ? 1 : 0)
        .input('nextStatus',  sql.VarChar(30),   nextStatus)
        .input('poNo',        sql.VarChar(30),   poNos.length ? poNos.join(', ').slice(0, 30) : null)
        .input('nonPOReason', sql.NVarChar(300), nonPOReason ? nonPOReason.slice(0, 300) : null)
        .input('versionNo',   sql.Int,           entry.VersionNo)
        .query(`UPDATE dbo.DeliveryEntries
                SET Status = @nextStatus, NetWeight = @netWeight,
                    Destination = @destination, LocationId = @locationId,
                    SkipQA = @skipQA,
                    PurchaseOrderNo = COALESCE(@poNo, PurchaseOrderNo),
                    NonPOReason = COALESCE(@nonPOReason, NonPOReason),
                    VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
                WHERE EntryId = @entryId AND VersionNo = @versionNo`);

      // Someone else weighed or edited this entry since it was loaded.
      if (updated.rowsAffected[0] === 0) {
        await transaction.rollback();
        return res.status(409).json({ error: `${entryNo} was changed by someone else just now — reload the list and check it` });
      }

      await transaction.commit();

      writeAuditLog({
        entityType: 'WeighbridgeRecord', entityId: wbIds[0],
        action: 'Create', userId: req.user.userId,
        newValues: { entryNo, ticketNo, itemCount: items.length, totalNet, poNos, nonPOReason: nonPOReason || null },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      writeStatusHistory({
        entityType: 'DeliveryEntry', entityId: entry.EntryId,
        fromStatus: entry.Status, toStatus: nextStatus,
        changedBy: req.user.userId,
        remarks: `Weighbridge completed (${items.length} item(s)). Routed to ${destination}${skipQA ? ' (QA Skipped)' : ''}`,
      });

      res.status(201).json({
        entryNo,
        destination,
        entryStatus: nextStatus,
        totalNetWeight: totalNet,
        itemsWeighed: items.length,
        ticketNo,
        poNos,
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/weighbridge/:entryNo — Get weighbridge record ────
router.get('/:entryNo', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('entryNo', sql.VarChar(20), req.params.entryNo)
      .query(`
        SELECT wr.*, de.EntryNo, u.FullName AS OperatorName
        FROM dbo.WeighbridgeRecords wr
        JOIN dbo.DeliveryEntries de ON de.EntryId = wr.EntryId
        JOIN dbo.Users u ON u.UserId = wr.OperatorId
        WHERE de.EntryNo = @entryNo
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'Weighbridge record not found' });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/weighbridge — List pending entries for weighbridge ────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const { dateFrom, dateTo } = req.query;
    const request = pool.request();

    let dateFilter = '';
    if (dateFrom) {
      dateFilter += ' AND de.DeliveryDate >= @dateFrom';
      request.input('dateFrom', sql.Date, dateFrom);
    }
    if (dateTo) {
      dateFilter += ' AND de.DeliveryDate <= @dateTo';
      request.input('dateTo', sql.Date, dateTo);
    }

    const entriesResult = await request.query(`
      SELECT de.EntryId, de.EntryNo, de.ConsignmentNo, de.DeliveryDate, de.DeliveryTime,
             de.VehicleRegNo, de.DriverName, de.Notes, de.Status, de.CreatedAt AS GateEntryAt,
             s.SupplierId, s.SupplierName, s.SupplierCode
      FROM dbo.DeliveryEntries de
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      WHERE de.Status IN ('GateReceived', 'WeighbridgePending')
      ${dateFilter}
      ORDER BY de.CreatedAt DESC
    `);

    if (entriesResult.recordset.length === 0) {
      return res.json([]);
    }

    const linkCols = await hasLinkColumns(pool);
    const entryIds = entriesResult.recordset.map((e) => e.EntryId).join(',');
    const itemsResult = await pool.request().query(`
      SELECT dei.EntryItemId, dei.EntryId, dei.Quantity, dei.UOM, dei.Description,
             ${linkCols ? 'dei.BusyItemCode, dei.BusyPORefCode, dei.BusyPONo,' : 'NULL AS BusyItemCode, NULL AS BusyPORefCode, NULL AS BusyPONo,'}
             m.MaterialCode, m.MaterialName
      FROM dbo.DeliveryEntryItems dei
      JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
      WHERE dei.EntryId IN (${entryIds})
      ORDER BY dei.EntryItemId ASC
    `);

    const itemsByEntry = {};
    for (const item of itemsResult.recordset) {
      if (!itemsByEntry[item.EntryId]) itemsByEntry[item.EntryId] = [];
      itemsByEntry[item.EntryId].push(item);
    }

    const entries = entriesResult.recordset.map((e) => ({
      ...e,
      items: itemsByEntry[e.EntryId] || [],
    }));

    res.json(entries);
  } catch (err) {
    next(err);
  }
});

module.exports = router;