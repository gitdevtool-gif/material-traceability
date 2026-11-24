/**
 * QA decision log (2026-11-11)
 *
 * When QA submits a decision, a fixed copy of what was submitted is kept in
 * dbo.QADecisionLog — the delivery, the inspection checks, every test result,
 * the decision, quantities, remarks and rejection reason — so the inspector
 * can look back at (and print) exactly what they submitted, even after the
 * delivery moves on, the inspection is redone, or Admin deletes it.
 */
const { sql } = require('../db');

const DECIDED = ['Accepted', 'Rejected', 'Quarantine', 'Conditional'];

/**
 * Everything the copy shows, read inside the caller's transaction (newReq
 * returns a request on it) so it matches what was just committed.
 * extra: { decisionRemarks, rejectionReason, rejectionNotes } as submitted.
 */
async function buildQaSnapshot(newReq, inspectionId, extra = {}) {
  const head = (await newReq().input('id', sql.Int, inspectionId).query(`
    SELECT qi.InspectionId, qi.InspectionNo, qi.InspectionDate, qi.OverallStatus, qi.AcceptedQty, qi.RejectedQty,
           qi.COAProvided, qi.COAReference, qi.SamplesTaken, qi.PhysicalCheckDone, qi.VehicleInspectionDone,
           qi.OverallRemarks, qi.ApprovedAt, qi.InspectorId, qi.ApprovedBy,
           ui.FullName AS InspectorName, ua.FullName AS ApprovedByName,
           de.EntryId, de.EntryNo, de.ConsignmentNo, de.VehicleRegNo, de.DriverName, de.PurchaseOrderNo,
           de.DeliveryDate, de.NetWeight, sl.LocationName AS Factory,
           s.SupplierName, s.SupplierCode
    FROM dbo.QAInspections qi
    JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
    JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
    LEFT JOIN dbo.StockLocations sl ON sl.LocationId = de.LocationId
    LEFT JOIN dbo.Users ui ON ui.UserId = qi.InspectorId
    LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
    WHERE qi.InspectionId = @id`)).recordset[0];
  if (!head) return null;

  // one after another: requests on one transaction share its connection
  const items = await newReq().input('e', sql.Int, head.EntryId).query(`
      SELECT m.MaterialCode, m.MaterialName, dei.Quantity, dei.UOM,
             (SELECT SUM(ISNULL(wr.FinalNetWeight, wr.NetWeight)) FROM dbo.WeighbridgeRecords wr WHERE wr.EntryItemId = dei.EntryItemId) AS NetKg
      FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
      WHERE dei.EntryId = @e ORDER BY dei.EntryItemId`);
  const tests = await newReq().input('id', sql.Int, inspectionId).query(`
      SELECT m.MaterialCode, m.MaterialName, tr.TestName, tr.TestMethod, tr.ExpectedValue, tr.ActualValue, tr.Result, tr.Remarks,
             tr.TestedAt, u.FullName AS TestedByName
      FROM dbo.QATestResults tr
      JOIN dbo.Materials m ON m.MaterialId = tr.MaterialId
      LEFT JOIN dbo.Users u ON u.UserId = tr.TestedBy
      WHERE tr.InspectionId = @id ORDER BY tr.TestedAt, tr.TestResultId`);
  const tickets = await newReq().input('e', sql.Int, head.EntryId)
    .query('SELECT DISTINCT TicketNo FROM dbo.WeighbridgeRecords WHERE EntryId = @e AND TicketNo IS NOT NULL');

  return {
    inspection: {
      inspectionNo: head.InspectionNo, inspectionDate: head.InspectionDate,
      coaProvided: !!head.COAProvided, coaReference: head.COAReference, samplesTaken: !!head.SamplesTaken,
      physicalCheckDone: !!head.PhysicalCheckDone, vehicleInspectionDone: !!head.VehicleInspectionDone,
      inspectorId: head.InspectorId, inspectorName: head.InspectorName,
    },
    entry: {
      entryId: head.EntryId, entryNo: head.EntryNo, consignmentNo: head.ConsignmentNo, vehicleRegNo: head.VehicleRegNo, driverName: head.DriverName,
      purchaseOrderNo: head.PurchaseOrderNo, deliveryDate: head.DeliveryDate, netWeight: head.NetWeight, factory: head.Factory,
      supplierName: head.SupplierName, supplierCode: head.SupplierCode,
      ticketNos: tickets.recordset.map((t) => t.TicketNo),
      items: items.recordset.map((i) => ({ code: i.MaterialCode, name: i.MaterialName, quantity: i.Quantity, uom: i.UOM, netKg: i.NetKg })),
    },
    tests: tests.recordset.map((t) => ({
      material: t.MaterialName, materialCode: t.MaterialCode, test: t.TestName, method: t.TestMethod, expected: t.ExpectedValue,
      actual: t.ActualValue, result: t.Result, remarks: t.Remarks, testedAt: t.TestedAt, testedBy: t.TestedByName,
    })),
    decision: {
      decision: head.OverallStatus, acceptedQty: head.AcceptedQty, rejectedQty: head.RejectedQty,
      remarks: extra.decisionRemarks ?? head.OverallRemarks ?? null,
      rejectionReason: extra.rejectionReason || null, rejectionNotes: extra.rejectionNotes || null,
      decidedAt: head.ApprovedAt, decidedById: head.ApprovedBy, decidedBy: head.ApprovedByName,
    },
  };
}

/** Write the copy (same transaction as the decision). */
async function writeQaDecisionLog(newReq, { inspectionId, submittedBy, source = 'Submitted', submittedAt = null, extra }) {
  const snap = await buildQaSnapshot(newReq, inspectionId, extra);
  if (!snap) return null;
  const r = await newReq()
    .input('inspId', sql.Int, inspectionId)
    .input('inspNo', sql.VarChar(20), snap.inspection.inspectionNo)
    .input('entryId', sql.Int, snap.entry.entryId)
    .input('entryNo', sql.VarChar(20), snap.entry.entryNo)
    .input('decision', sql.VarChar(20), snap.decision.decision)
    .input('acc', sql.Decimal(12, 2), snap.decision.acceptedQty)
    .input('rej', sql.Decimal(12, 2), snap.decision.rejectedQty)
    .input('inspector', sql.Int, snap.inspection.inspectorId)
    .input('by', sql.Int, submittedBy)
    .input('at', sql.DateTime2, submittedAt)
    .input('source', sql.VarChar(20), source)
    .input('snap', sql.NVarChar(sql.MAX), JSON.stringify(snap))
    .query(`INSERT INTO dbo.QADecisionLog
              (InspectionId, InspectionNo, EntryId, EntryNo, Decision, AcceptedQty, RejectedQty, InspectorId, SubmittedBy, SubmittedAt, Source, Snapshot)
            OUTPUT INSERTED.LogId
            VALUES (@inspId, @inspNo, @entryId, @entryNo, @decision, @acc, @rej, @inspector, @by, COALESCE(@at, SYSUTCDATETIME()), @source, @snap)`);
  return r.recordset[0].LogId;
}

module.exports = { DECIDED, buildQaSnapshot, writeQaDecisionLog };
