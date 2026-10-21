/**
 * End-to-end order trace (2026-10-17)
 *
 * One requisition followed through every stage, in this system and in Busy:
 *   Requisition → Central Stores → Ops Manager → RFQ dispatched → quotes →
 *   Director's award → Busy PO → gate / weighbridge / QA (this system) →
 *   Busy GRN → purchase bill → payment
 * plus a reconciliation of quantities and prices at each step.
 *
 * Links used (all existing records — nothing new is stored):
 *   award → Busy PO       LPOReconciliation (RFQId [+ SupplierId for split awards]).BusyPurOrdNo
 *   PO line → receipts    Busy Tran3 pending-order refs (RecType 4): the PO line
 *                         creates the ref (Method 1), each GRN / purchase that
 *                         receives against it consumes it (Method 2)
 *   receipt → gate entry  DeliveryEntries.BusyGRNVchCode / DeliveryEntryItems.BusyPOVchCode
 *   GRN → bill → payment  busy-receiving.service.js getGrnLifecycle / getBillPayments
 * Read-only.
 */
const { sql } = require('../db');
const { sql: erpSql } = require('../erpDb');
const { getGrns, getGrnLifecycle, getBillPayments } = require('./busy-receiving.service');
const { hasLinkColumns } = require('./entry-grn-link.service');

const norm = (s) => String(s || '').trim().toUpperCase();
// Busy PO prices are ex VAT; quotes can be VAT-inclusive (Kenya VAT 16%).
const VAT_RATE = Number(process.env.VAT_RATE) || 0.16;
const r3 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
const r2 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);

async function loadRequisition(pool, requisitionId) {
  const head = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT r.*, cu.FullName AS CreatedByName, cs.FullName AS CentralStoresByName, op.FullName AS OpsByName
    FROM dbo.Requisitions r
    LEFT JOIN dbo.Users cu ON cu.UserId = r.CreatedByUserId
    LEFT JOIN dbo.Users cs ON cs.UserId = r.CentralStoresApprovedByUserId
    LEFT JOIN dbo.Users op ON op.UserId = r.OpsApprovedByUserId
    WHERE r.RequisitionId = @id`)).recordset[0];
  if (!head) return null;

  const items = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty, ri.Unit, ri.RFQId,
           ia.Decision AS OpsDecision, ia.ApprovedQty AS OpsApprovedQty, ia.DecidedAt AS OpsDecidedAt, iu.FullName AS OpsDecidedBy,
           h.Reason AS HoldReason, h.HeldAt
    FROM dbo.RequisitionItems ri
    LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
    LEFT JOIN dbo.Users iu ON iu.UserId = ia.DecidedByUserId
    LEFT JOIN dbo.RFQItemHolds h ON h.RequisitionItemId = ri.RequisitionItemId AND h.RFQId = ri.RFQId
    WHERE ri.RequisitionId = @id ORDER BY ri.RequisitionItemId`)).recordset;

  const csDecisions = (await pool.request().input('id', sql.Int, requisitionId).query(`
    SELECT cd.ItemName, cd.RequestedQty, cd.Decision, cd.ApprovedQty, cd.RejectionReason, cd.DecidedAt, u.FullName AS DecidedBy
    FROM dbo.CentralStoresItemDecisions cd LEFT JOIN dbo.Users u ON u.UserId = cd.DecidedByUserId
    WHERE cd.RequisitionId = @id`)).recordset;
  return { head, items, csDecisions };
}

/** RFQ, dispatches, quotes and award per requisition item. */
async function loadSourcing(pool, items) {
  const rfqIds = [...new Set(items.map((i) => i.RFQId).filter(Boolean))];
  const itemIds = items.map((i) => i.RequisitionItemId);
  if (!itemIds.length) return { rfqs: {}, quotes: {}, awards: {}, lpos: [] };

  const rfqs = {};
  const lpos = [];
  if (rfqIds.length) {
    const rq = pool.request();
    rfqIds.forEach((id, k) => rq.input(`r${k}`, sql.Int, id));
    const inR = rfqIds.map((_, k) => `@r${k}`).join(',');
    for (const r of (await rq.query(`
      SELECT rfq.RFQId, rfq.RFQNumber, rfq.IssuedAt, rfq.DeadlineAt, u.FullName AS IssuedBy,
             (SELECT COUNT(*) FROM dbo.RFQDispatches d WHERE d.RFQId = rfq.RFQId) AS Dispatches,
             (SELECT MIN(d.SentAt) FROM dbo.RFQDispatches d WHERE d.RFQId = rfq.RFQId) AS FirstSentAt,
             (SELECT COUNT(*) FROM dbo.Quotations q WHERE q.RFQId = rfq.RFQId AND ISNULL(q.IsWithdrawn, 0) = 0) AS Quotes,
             ev.QuoteEvaluationId, ev.ApprovedAt AS AwardedAt, ev.WinningQuotationId, du.FullName AS Director
      FROM dbo.RFQs rfq
      LEFT JOIN dbo.Users u ON u.UserId = rfq.IssuedByUserId
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.RFQId = rfq.RFQId
      LEFT JOIN dbo.Users du ON du.UserId = ev.DirectorUserId
      WHERE rfq.RFQId IN (${inR})`)).recordset) rfqs[r.RFQId] = r;

    const lq = pool.request();
    rfqIds.forEach((id, k) => lq.input(`r${k}`, sql.Int, id));
    lpos.push(...(await lq.query(`
      SELECT rec.RFQId, rec.SupplierId, LTRIM(RTRIM(rec.BusyPurOrdNo)) AS BusyPurOrdNo, rec.BusyDate, rec.ReconciledAt,
             rec.TotalQuotedAmt, rec.TotalActualAmt, rec.VarianceAmt, rec.Notes, u.FullName AS LinkedBy
      FROM dbo.LPOReconciliation rec LEFT JOIN dbo.Users u ON u.UserId = rec.ReconciledByUserId
      WHERE rec.RFQId IN (${inR})`)).recordset);
  }

  const iq = pool.request();
  itemIds.forEach((id, k) => iq.input(`i${k}`, sql.Int, id));
  const inI = itemIds.map((_, k) => `@i${k}`).join(',');
  const quotes = {};
  for (const q of (await iq.query(`
    SELECT li.RequisitionItemId, COUNT(*) AS Quotes, MIN(CASE WHEN ISNULL(li.IsNotAvailable, 0) = 0 THEN li.UnitPrice END) AS LowestPrice
    FROM dbo.QuotationLineItems li JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId AND ISNULL(q.IsWithdrawn, 0) = 0
    WHERE li.RequisitionItemId IN (${inI}) GROUP BY li.RequisitionItemId`)).recordset) quotes[q.RequisitionItemId] = q;

  const aq = pool.request();
  itemIds.forEach((id, k) => aq.input(`i${k}`, sql.Int, id));
  const awards = {};
  for (const a of (await aq.query(`
    SELECT qei.RequisitionItemId, qei.SupplierId, s.SupplierName, s.SupplierCode, qei.UnitPrice, qei.Qty, li.IsVatInclusive
    FROM dbo.QuoteEvaluationItems qei
    JOIN dbo.Suppliers s ON s.SupplierId = qei.SupplierId
    LEFT JOIN dbo.QuotationLineItems li ON li.QuotationLineItemId = qei.QuotationLineItemId
    WHERE qei.RequisitionItemId IN (${inI})
    UNION ALL
    SELECT li.RequisitionItemId, q.SupplierId, s.SupplierName, s.SupplierCode, li.UnitPrice, li.Qty, li.IsVatInclusive
    FROM dbo.QuoteEvaluations ev
    JOIN dbo.Quotations q ON q.QuotationId = ev.WinningQuotationId
    JOIN dbo.QuotationLineItems li ON li.QuotationId = q.QuotationId
    JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
    WHERE li.RequisitionItemId IN (${inI})
      AND NOT EXISTS (SELECT 1 FROM dbo.QuoteEvaluationItems x WHERE x.QuoteEvaluationId = ev.QuoteEvaluationId)`)).recordset) {
    awards[a.RequisitionItemId] = a;
  }
  return { rfqs, quotes, awards, lpos };
}

/** Busy PO + every receipt against each of its lines. Keyed by PO number. */
async function loadBusyPos(erpPool, poNos) {
  const out = {};
  if (!poNos.length) return out;
  const req = erpPool.request();
  poNos.forEach((n, k) => req.input(`p${k}`, erpSql.NVarChar(50), n));
  const heads = (await req.query(`
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.ApprovalStatus, t1.VchAmtBaseCur AS Amount,
           LTRIM(RTRIM(p.Name)) AS Party
    FROM dbo.Tran1 t1 LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
    WHERE t1.VchType = 13 AND LTRIM(RTRIM(t1.VchNo)) IN (${poNos.map((_, k) => `@p${k}`).join(',')})`)).recordset;
  if (!heads.length) return out;

  const vcs = heads.map((h) => h.VchCode).join(',');
  const lines = (await erpPool.request().query(`
    SELECT t3.VchCode, t3.RefCode, t3.MasterCode1 AS ItemCode, LTRIM(RTRIM(it.Name)) AS ItemName,
           ABS(t3.Value1) AS Ordered, t3.Value3 AS Price
    FROM dbo.Tran3 t3 LEFT JOIN dbo.Master1 it ON it.Code = t3.MasterCode1
    WHERE t3.VchType = 13 AND t3.Method = 1 AND t3.RecType = 4 AND t3.VchCode IN (${vcs})`)).recordset;
  const refs = lines.map((l) => l.RefCode);
  const receipts = refs.length ? (await erpPool.request().query(`
    SELECT x.RefCode, x.VchCode, x.VchType, x.[Date], ABS(x.Value1) AS Qty
    FROM dbo.Tran3 x WHERE x.RecType = 4 AND x.Method = 2 AND x.RefCode IN (${refs.join(',')})`)).recordset : [];

  for (const h of heads) {
    out[h.VchNo] = {
      vchCode: h.VchCode, poNo: h.VchNo, date: h.Date, approved: h.ApprovalStatus !== 2,
      party: h.Party, amount: Number(h.Amount) || 0,
      lines: lines.filter((l) => l.VchCode === h.VchCode).map((l) => {
        const rec = receipts.filter((r) => r.RefCode === l.RefCode);
        const received = rec.reduce((s, r) => s + (Number(r.Qty) || 0), 0);
        return {
          refCode: l.RefCode, itemCode: l.ItemCode, itemName: l.ItemName,
          ordered: r3(l.Ordered), price: r2(l.Price), received: r3(received), pending: r3(Math.max(0, l.Ordered - received)),
          receipts: rec.map((r) => ({ vchCode: r.VchCode, vchType: r.VchType, date: r.Date, qty: r3(r.Qty) })),
        };
      }),
    };
  }
  return out;
}

async function loadGateEntries(pool, { grnVchCodes, poVchCodes }) {
  if (!(await hasLinkColumns(pool)) || (!grnVchCodes.length && !poVchCodes.length)) return [];
  const conds = [];
  if (grnVchCodes.length) conds.push(`de.BusyGRNVchCode IN (${grnVchCodes.join(',')})`);
  if (poVchCodes.length) conds.push(`EXISTS (SELECT 1 FROM dbo.DeliveryEntryItems i WHERE i.EntryId = de.EntryId AND i.BusyPOVchCode IN (${poVchCodes.join(',')}))`);
  return (await pool.request().query(`
    SELECT de.EntryId, de.EntryNo, de.Status, de.DeliveryDate, de.VehicleRegNo, de.BusyGRNVchCode, de.BusyGRNNo,
           wr.TicketNo, wr.NetWeight,
           (SELECT TOP 1 qi.OverallStatus FROM dbo.QAInspections qi WHERE qi.EntryId = de.EntryId ORDER BY qi.InspectionId DESC) AS QAStatus,
           (SELECT TOP 1 qi.AcceptedQty FROM dbo.QAInspections qi WHERE qi.EntryId = de.EntryId ORDER BY qi.InspectionId DESC) AS QAAcceptedQty,
           (SELECT TOP 1 qi.RejectedQty FROM dbo.QAInspections qi WHERE qi.EntryId = de.EntryId ORDER BY qi.InspectionId DESC) AS QARejectedQty,
           (SELECT STRING_AGG(CAST(i.BusyPOVchCode AS VARCHAR(12)), ',') FROM dbo.DeliveryEntryItems i WHERE i.EntryId = de.EntryId) AS PoVchCodes
    FROM dbo.DeliveryEntries de LEFT JOIN dbo.WeighbridgeRecords wr ON wr.EntryId = de.EntryId
    WHERE ${conds.join(' OR ')}`)).recordset;
}

const stage = (key, label, state, detail = {}) => ({ key, label, state, ...detail });

/**
 * Full trace of one requisition. `resolveItemCodes(names)` maps item names
 * to Busy item codes (stock.service resolveItems) so a PO line is matched to
 * the right requisition item.
 */
async function traceRequisition(pool, erpPool, requisitionId, { resolveItems }) {
  const req = await loadRequisition(pool, requisitionId);
  if (!req) return null;
  const { head, items, csDecisions } = req;
  const sourcing = await loadSourcing(pool, items);

  const busyItems = await resolveItems(erpPool, { itemNames: items.map((i) => i.ItemCode || i.ItemName) });
  const codeByName = new Map(busyItems.map((b) => [norm(b.itemName), b.itemCode]));

  const poNos = [...new Set(sourcing.lpos.map((l) => l.BusyPurOrdNo))];
  const pos = await loadBusyPos(erpPool, poNos);
  const receiptVchCodes = [...new Set(Object.values(pos).flatMap((p) => p.lines.flatMap((l) => l.receipts.map((r) => r.vchCode))))];
  const grns = await getGrns(erpPool, { vchCodes: receiptVchCodes });
  const grnMap = new Map(grns.map((g) => [g.vchCode, g]));
  const life = await getGrnLifecycle(erpPool, grns.map((g) => g.vchCode));
  // Purchases raised straight against the PO (no GRN): their own bill status.
  const directPurch = receiptVchCodes.filter((v) => !grnMap.has(v));
  const directBills = await getBillPayments(erpPool, directPurch);
  const gate = await loadGateEntries(pool, { grnVchCodes: grns.map((g) => g.vchCode), poVchCodes: Object.values(pos).map((p) => p.vchCode) });

  const traced = items.map((it) => {
    const busyName = it.ItemCode || it.ItemName;
    const itemCode = codeByName.get(norm(busyName)) || null;
    const cs = csDecisions.find((d) => norm(d.ItemName) === norm(it.ItemName)) || null;
    const rfq = it.RFQId ? sourcing.rfqs[it.RFQId] : null;
    const q = sourcing.quotes[it.RequisitionItemId] || null;
    const award = sourcing.awards[it.RequisitionItemId] || null;
    const lpo = award && it.RFQId
      ? sourcing.lpos.find((l) => l.RFQId === it.RFQId && (l.SupplierId === award.SupplierId || l.SupplierId === null)) || null
      : null;
    const po = lpo ? pos[lpo.BusyPurOrdNo] || null : null;
    const poLine = po
      ? po.lines.find((l) => itemCode && l.itemCode === itemCode) || po.lines.find((l) => norm(l.itemName) === norm(busyName)) || (po.lines.length === 1 ? po.lines[0] : null)
      : null;

    const receipts = (poLine?.receipts || []).map((r) => {
      const g = grnMap.get(r.vchCode);
      const lc = g ? life[g.vchCode] : null;
      const db = directBills[r.vchCode];
      const entries = gate.filter((e) => (g && e.BusyGRNVchCode === g.vchCode));
      return {
        date: r.date, qty: r.qty,
        kind: g ? 'GRN' : 'Purchase bill (no GRN)',
        voucher: g ? g.grnNo : db?.billNo || null,
        vehicle: g?.vehicle || null,
        billed: g ? lc?.billed : 'Billed',
        paid: g ? lc?.paid : db?.state || null,
        bills: g ? lc?.bills || [] : db ? [db] : [],
        gateEntries: entries.map((e) => ({
          entryNo: e.EntryNo, status: e.Status, date: e.DeliveryDate, vehicle: e.VehicleRegNo,
          ticketNo: e.TicketNo, netWeight: e.NetWeight, qa: e.QAStatus, qaAccepted: e.QAAcceptedQty, qaRejected: e.QARejectedQty,
        })),
      };
    });
    // Trucks at the gate for this PO that aren't received in Busy yet.
    const atGate = po ? gate.filter((e) => !e.BusyGRNVchCode && String(e.PoVchCodes || '').split(',').includes(String(po.vchCode)))
      .map((e) => ({ entryNo: e.EntryNo, status: e.Status, date: e.DeliveryDate, qa: e.QAStatus })) : [];

    // Award vs PO compared on VALUE ex VAT: Procurement often raises the PO
    // in Busy's unit (600 L @ 209.05) for an award quoted per pack (30
    // jerrycans @ 4,850 incl. VAT) — same money, different unit.
    const awardValueExVat = award ? (Number(award.Qty) * Number(award.UnitPrice)) / (award.IsVatInclusive ? 1 + VAT_RATE : 1) : null;
    const poValue = poLine ? poLine.ordered * (poLine.price || 0) : null;
    const valueDiff = awardValueExVat != null && poValue != null ? poValue - awardValueExVat : null;
    const valueMatches = valueDiff != null && Math.abs(valueDiff) <= Math.max(1, 0.01 * Math.abs(awardValueExVat));

    const billedAmt = receipts.flatMap((r) => r.bills).reduce((s, b) => s + (b.amount || 0), 0);
    const paidAmt = receipts.flatMap((r) => r.bills).reduce((s, b) => s + (b.paid || 0), 0);
    const opsNeeded = head.OpsApprovedAt || it.OpsDecision;

    const stages = [
      stage('requisition', 'Requisition raised', 'done', { at: head.BusyDate || head.CreatedAt, by: head.CreatedByName, info: `${head.BusyOrdNo} · ${head.MatCenter || ''}` }),
      stage('centralStores', 'Central Stores', cs ? (cs.Decision === 'Approved' ? 'done' : 'rejected') : head.Source === 'Busy' ? 'na' : head.Status === 'PendingCentralStoresApproval' ? 'pending' : 'na',
        cs ? { at: cs.DecidedAt, by: cs.DecidedBy, info: cs.Decision === 'Approved' ? `approved ${cs.ApprovedQty}` : `rejected: ${cs.RejectionReason}` } : {}),
      stage('ops', 'Ops Manager', it.OpsDecision ? (it.OpsDecision === 'Approved' ? 'done' : it.OpsDecision === 'Rejected' ? 'rejected' : 'pending')
        : head.Status === 'PendingOpsApproval' ? 'pending' : opsNeeded ? 'done' : 'na',
        it.OpsDecision ? { at: it.OpsDecidedAt, by: it.OpsDecidedBy, info: `${it.OpsDecision}${it.OpsApprovedQty != null ? ` ${it.OpsApprovedQty}` : ''}` } : {}),
      stage('rfq', 'RFQ sent to suppliers', rfq ? (rfq.Dispatches > 0 ? 'done' : 'pending') : it.HoldReason ? 'held' : 'pending',
        rfq ? { at: rfq.FirstSentAt || rfq.IssuedAt, by: rfq.IssuedBy, info: `${rfq.RFQNumber} · ${rfq.Dispatches} supplier(s)` } : it.HoldReason ? { info: `held: ${it.HoldReason}` } : {}),
      stage('quotes', 'Quotations', q && q.Quotes > 0 ? 'done' : rfq ? 'pending' : 'na',
        q ? { info: `${q.Quotes} quote(s)${q.LowestPrice != null ? ` · lowest ${r2(q.LowestPrice)}` : ''}` } : {}),
      stage('award', 'Director award', award && rfq?.AwardedAt ? 'done' : q?.Quotes ? 'pending' : 'na',
        award ? { at: rfq?.AwardedAt, by: rfq?.Director, info: `${award.SupplierName} · ${award.Qty} @ ${r2(award.UnitPrice)}${award.IsVatInclusive ? ' (VAT incl.)' : ''}` } : {}),
      stage('po', 'Busy PO', po ? (po.approved ? 'done' : 'pending') : award ? 'pending' : 'na',
        po ? { at: po.date, by: lpo.LinkedBy, info: `${po.poNo}${po.approved ? '' : ' · awaiting approval in Busy'}${poLine ? ` · ${poLine.ordered} @ ${poLine.price}` : ''}` } : {}),
      stage('gate', 'At the gate / QA',
        receipts.some((r) => r.gateEntries.length) || atGate.length ? 'done' : receipts.length ? 'skipped' : po ? 'pending' : 'na',
        { info: [...receipts.flatMap((r) => r.gateEntries.map((e) => `${e.entryNo}${e.qa ? ` QA ${e.qa}` : ''}`)), ...atGate.map((e) => `${e.entryNo} (${e.status})`)].join(', ')
            || (receipts.length ? 'received in Busy with no gate entry here' : undefined) }),
      stage('grn', 'Received (Busy GRN)', poLine ? (poLine.pending <= 0.0001 ? 'done' : poLine.received > 0 ? 'partial' : 'pending') : 'na',
        poLine ? { info: `${poLine.received} of ${poLine.ordered} received${receipts.length ? ` · ${receipts.map((r) => r.voucher).filter(Boolean).join(', ')}` : ''}` } : {}),
      stage('bill', 'Supplier bill', receipts.length ? (receipts.every((r) => r.billed === 'Billed') ? 'done' : receipts.some((r) => r.billed !== 'Not billed') ? 'partial' : 'pending') : 'na',
        billedAmt ? { info: `KES ${r2(billedAmt).toLocaleString()} billed` } : {}),
      stage('payment', 'Paid', billedAmt ? (paidAmt + 0.5 >= billedAmt ? 'done' : paidAmt > 0 ? 'partial' : 'pending') : 'na',
        billedAmt ? { info: `KES ${r2(paidAmt).toLocaleString()} of ${r2(billedAmt).toLocaleString()} paid` } : {}),
    ];

    return {
      requisitionItemId: it.RequisitionItemId,
      itemName: it.ItemName,
      busyItemCode: itemCode,
      unit: it.Unit,
      stages,
      reconciliation: {
        requestedQty: cs ? r3(cs.RequestedQty) : r3(it.Qty),
        centralStoresQty: cs?.Decision === 'Approved' ? r3(cs.ApprovedQty) : null,
        opsApprovedQty: it.OpsApprovedQty != null ? r3(it.OpsApprovedQty) : null,
        awardedQty: award ? r3(award.Qty) : null,
        awardedPrice: award ? r2(award.UnitPrice) : null,
        poQty: poLine?.ordered ?? null,
        poPrice: poLine?.price ?? null,
        receivedQty: poLine?.received ?? null,
        pendingQty: poLine?.pending ?? null,
        billedAmount: billedAmt ? r2(billedAmt) : null,
        paidAmount: billedAmt ? r2(paidAmt) : null,
        // Flags for the reader: where the order changed along the way.
        awardedValueExVat: awardValueExVat != null ? r2(awardValueExVat) : null,
        poValue: poValue != null ? r2(poValue) : null,
        flags: [
          award && Number(award.Qty) <= 0 ? 'awarded quantity is 0 on the evaluation' : null,
          valueDiff != null && !valueMatches ? `PO value ${r2(poValue).toLocaleString()} ≠ awarded ${r2(awardValueExVat).toLocaleString()} (ex VAT)` : null,
          valueMatches && award && poLine && Math.abs(award.Qty - poLine.ordered) > 0.0001
            ? `same value, different unit: awarded ${award.Qty} @ ${r2(award.UnitPrice)}, PO ${poLine.ordered} @ ${poLine.price}` : null,
          poLine && poLine.received > poLine.ordered + 0.0001 ? `received ${poLine.received} > ordered ${poLine.ordered}` : null,
          lpo && !po ? `Busy PO ${lpo.BusyPurOrdNo} not found in Busy` : null,
          po && !poLine ? `item not found on ${po.poNo}` : null,
        ].filter(Boolean),
      },
      receipts,
      atGate,
      lpo: lpo ? { poNo: lpo.BusyPurOrdNo, quotedTotal: r2(lpo.TotalQuotedAmt), busyTotal: r2(lpo.TotalActualAmt), variance: r2(lpo.VarianceAmt), linkedBy: lpo.LinkedBy, notes: lpo.Notes } : null,
    };
  });

  return {
    requisition: {
      requisitionId: head.RequisitionId, number: head.BusyOrdNo, date: head.BusyDate || head.CreatedAt,
      status: head.Status, store: head.MatCenter, source: head.Source, raisedBy: head.CreatedByName,
    },
    items: traced,
  };
}

module.exports = { traceRequisition };
