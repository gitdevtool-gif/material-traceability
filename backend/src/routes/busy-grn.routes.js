/**
 * Receive in Busy (2026-10-21) — Stores receive a delivery as a Busy GRN
 * from this system instead of re-typing it in Busy, and print the GRN that
 * goes to Accounts for payment.
 *
 *   GET  /:entryId/draft     what the GRN would be: PO line + quantity per item, suggested
 *   POST /:entryId/preview   { lines, deliveryNote } → checked against Busy, nothing saved
 *   POST /:entryId/push      saves the GRN in Busy (Busy assigns the number), links it here
 *   GET  /:entryId/print     everything the printed GRN shows (any delivery with a Busy GRN)
 *
 * Same safeguards as raising POs: preview first; one push per delivery at a
 * time; a retry links the GRN Busy already saved instead of receiving twice;
 * the user's own verified Busy login is recorded as "added by"; quantities
 * and amounts are read back from Busy. Off until BUSY_GRN_PUSH_ENABLED=true.
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool, sql: erpSql } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/audit.service');
const config = require('../config');
const logger = require('../logger');
const busyBridge = require('../services/busy-bridge.service');
const { resolveBusyUser, attributeToBusyUser } = require('../services/busy-po.service');
const { getGrns, getGrnLifecycle } = require('../services/busy-receiving.service');
const { linkEntryToGrn } = require('../services/entry-grn-link.service');
const { GRN_VCHTYPE, buildGrn, buildGrnRejectionAmend, addChallanRefs, findExistingPushedGrn, grnPoRefs, loadEntry } = require('../services/busy-grn.service');

const router = express.Router();
const RECEIVE_ROLES = ['StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'Admin'];

const NOT_ENABLED = 'Receiving GRNs in Busy from this system is not switched on yet — receive it in Busy and link it.';
const BUSY_LINK_PROBLEM = 'Link your own Busy login first (your Busy user name and password) so Busy records you as the person who received these goods.';

// Only a Busy login the user has proved with their Busy password counts.
async function getReceivingBusyUser(pool, erpPool, userId) {
  const u = (await pool.request().input('id', sql.Int, userId)
    .query('SELECT BusyUserName, BusyUserVerifiedAt FROM dbo.Users WHERE UserId = @id')).recordset[0];
  if (!u?.BusyUserVerifiedAt) return null;
  return resolveBusyUser(erpPool, u.BusyUserName);
}

// lines: [{ entryItemId, refCodes: [PO line ref, ...], qty }] — `refCode` (one PO line) still accepted
const parseLines = (lines) => (Array.isArray(lines) ? lines : []).slice(0, 50).map((l) => ({
  entryItemId: parseInt(l.entryItemId, 10),
  refCodes: (Array.isArray(l.refCodes) ? l.refCodes : [l.refCode]).slice(0, 10)
    .map((r) => parseInt(r, 10)).filter((r) => Number.isFinite(r) && r > 0),
  qty: l.qty === '' || l.qty === null || l.qty === undefined ? null : Number(l.qty),
  // blank = QA's rejection %; 0 = none
  rejectionPct: l.rejectionPct === '' || l.rejectionPct === null || l.rejectionPct === undefined ? null : Number(l.rejectionPct),
}));

/** Weighed kg in the PO line's unit where that is plain arithmetic. */
function qtyFromKg(unit, kg) {
  const u = String(unit || '').trim().toLowerCase().replace(/\./g, '');
  if (!(kg > 0)) return null;
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(u)) return Math.round(kg * 1000) / 1000;
  if (/^(ton|tons|tonne|tonnes|mt)$/.test(u)) return Math.round(kg) / 1000;
  return null;
}

const deliveryNoteOf = (notes) => {
  const n = String(notes || '').trim();
  return n ? (/^del/i.test(n) ? n : `Del.No.${n}`) : '';
};

// ── GET /:entryId/draft ──────────────────────────────────────────────────────
router.get('/:entryId/draft', authenticate, authorize(...RECEIVE_ROLES), async (req, res, next) => {
  try {
    const entryId = parseInt(req.params.entryId, 10);
    const pool = await getPool();
    const erpPool = await getErpPool();
    const entry = await loadEntry(pool, entryId);
    if (!entry) return res.status(404).json({ error: 'Delivery not found' });

    // First pass with no lines just to get the supplier's open PO lines.
    const base = await buildGrn(pool, erpPool, { entryId, lines: [], seriesName: config.busyCom.grnSeriesName });
    const used = new Set();
    const lines = base.entryItems.map((it) => {
      const forItem = base.openLines.filter((l) => !it.busyItemCode || l.itemCode === it.busyItemCode);
      const free = forItem.filter((l) => l.approved && !used.has(l.refCode));
      const tagged = forItem.find((l) => l.refCode === it.refCode);
      let qty = null;
      if (it.busyItemCode && it.quantity != null) qty = Number(it.quantity);
      else if (tagged || free.length === 1) qty = qtyFromKg((tagged || free[0]).unitName, Number(it.netKg));
      // Suggest the PO line(s) the way Stores pick them in Busy: the line the
      // gate tagged, then — for a known item — the oldest approved lines until
      // the quantity is covered (e.g. Pur-2838 5,000 + Pur-2944 1,250 = 6,250).
      const chosen = tagged ? [tagged] : [];
      if (it.busyItemCode && qty > 0) {
        let left = qty - (tagged ? tagged.pending : 0);
        for (const l of free) {
          if (left <= 0.0005) break;
          if (l !== tagged) { chosen.push(l); left -= l.pending; }
        }
      } else if (!tagged && free.length === 1) chosen.push(free[0]);
      chosen.forEach((l) => used.add(l.refCode));
      return { entryItemId: it.entryItemId, refCodes: chosen.map((l) => l.refCode), qty, rejectionPct: base.qaRejectionPct };
    });
    const deliveryNote = deliveryNoteOf(entry.Notes);
    const grn = await buildGrn(pool, erpPool, { entryId, lines, deliveryNote, seriesName: config.busyCom.grnSeriesName });
    delete grn.xml;
    const busyUser = await getReceivingBusyUser(pool, erpPool, req.user.userId);
    res.json({ enabled: config.busyCom.grnEnabled, ...grn, draftLines: lines, deliveryNote, busyUser, needsBusyLink: !busyUser });
  } catch (err) { next(err); }
});

// ── POST /:entryId/preview ───────────────────────────────────────────────────
router.post('/:entryId/preview', authenticate, authorize(...RECEIVE_ROLES), async (req, res, next) => {
  try {
    const entryId = parseInt(req.params.entryId, 10);
    const pool = await getPool();
    const erpPool = await getErpPool();
    const grn = await buildGrn(pool, erpPool, {
      entryId, lines: parseLines(req.body.lines), deliveryNote: req.body.deliveryNote, seriesName: config.busyCom.grnSeriesName,
    });
    delete grn.xml;
    const busyUser = await getReceivingBusyUser(pool, erpPool, req.user.userId);
    if (!config.busyCom.grnEnabled) grn.problems.push(NOT_ENABLED);
    if (!busyUser) grn.problems.push(BUSY_LINK_PROBLEM);
    res.json({ enabled: config.busyCom.grnEnabled, ...grn, busyUser, needsBusyLink: !busyUser });
  } catch (err) { next(err); }
});

// ── POST /:entryId/push ──────────────────────────────────────────────────────
const pushesInFlight = new Set();

router.post('/:entryId/push', authenticate, authorize(...RECEIVE_ROLES), async (req, res, next) => {
  const entryId = parseInt(req.params.entryId, 10);
  let locked = false;
  try {
    if (!config.busyCom.grnEnabled) return res.status(503).json({ error: NOT_ENABLED });
    if (pushesInFlight.has(entryId)) return res.status(409).json({ error: 'This delivery is already being received in Busy — wait a moment.' });
    pushesInFlight.add(entryId);
    locked = true;

    const pool = await getPool();
    const erpPool = await getErpPool();
    const busyUser = await getReceivingBusyUser(pool, erpPool, req.user.userId);
    if (!busyUser) return res.status(403).json({ error: BUSY_LINK_PROBLEM, needsBusyLink: true });

    const grn = await buildGrn(pool, erpPool, {
      entryId, lines: parseLines(req.body.lines), deliveryNote: req.body.deliveryNote, seriesName: config.busyCom.grnSeriesName,
    });
    if (grn.problems.length) return res.status(422).json({ error: grn.problems[0], problems: grn.problems });

    // A previous attempt may have saved in Busy and then failed here — link that GRN.
    let saved = await findExistingPushedGrn(erpPool, { entryNo: grn.entryNo, partyCode: grn.party.Code });
    const reused = !!saved;
    const warnings = [];
    if (saved) {
      saved = { vchCode: saved.VchCode, vchNo: saved.VchNo };
    } else {
      const r = await busyBridge.addVoucher(GRN_VCHTYPE, grn.xml);
      if (!r.ok) {
        logger.warn(`[BusyGrn] Busy rejected GRN for ${grn.entryNo}: ${r.error}`);
        return res.status(502).json({ error: `Busy did not save the GRN: ${r.error}` });
      }
      saved = { vchCode: r.vchCode, vchNo: r.vchNo };
      logger.info(`[BusyGrn] Busy saved ${saved.vchNo} (VchCode ${saved.vchCode}) for ${grn.entryNo}`);
    }
    // Busy's AddVchFromXML doesn't create the GRN's own pending-challan refs,
    // without which Accounts can't pick the GRN on a Purchase (2026-11-17).
    // Add them now that Busy has given the GRN its number.
    try {
      const ch = await addChallanRefs(erpPool, saved.vchCode);
      if (!ch.ok) {
        warnings.push(`${saved.vchNo} is received, but Accounts may not see it for billing yet (${ch.error}). Ask an Admin to run repair-grn-challans for it.`);
        logger.warn(`[BusyGrn] challan refs for ${saved.vchNo} not added: ${ch.error}`);
      }
    } catch (err) {
      warnings.push(`${saved.vchNo} is received, but Accounts may not see it for billing yet. Ask an Admin to run repair-grn-challans for it.`);
      logger.error(`[BusyGrn] challan refs for ${saved.vchNo} failed: ${err.message}`);
    }
    // also on a retry: a bridge timeout can leave the saved GRN as Supervisor's
    try {
      await attributeToBusyUser(erpPool, { vchCode: saved.vchCode, vchNo: saved.vchNo, busyUserName: busyUser });
    } catch (err) {
      warnings.push(`${saved.vchNo} shows as added by Supervisor in Busy — could not record who received it.`);
      logger.error(`[BusyGrn] Could not set Busy "added by" on ${saved.vchNo}: ${err.message}`);
    }

    // Did Busy take the PO link and the totals we sent?
    const refs = await grnPoRefs(erpPool, saved.vchCode);
    const missing = grn.lines.flatMap((l) => l.refs.filter((r) => !refs.some((x) => x.RefCode === r.refCode)).map((r) => ({ ...r, itemName: l.itemName })));
    if (missing.length) {
      warnings.push(refs.length
        ? `Busy saved ${saved.vchNo} against a different PO line than chosen for ${missing.map((r) => `${r.itemName} (${r.refNo || r.poNo})`).join(', ')} — the price may be wrong. Open ${saved.vchNo} in Busy and correct the PO line before the bill is made.`
        : `Busy saved ${saved.vchNo} but did not reduce the PO for ${missing.map((r) => `${r.itemName} (${r.poNo})`).join(', ')} — open ${saved.vchNo} in Busy and pick the PO before the bill is made.`);
      logger.warn(`[BusyGrn] ${saved.vchNo}: PO refs missing for ${missing.map((r) => r.refCode).join(',')}`);
    }
    const [busyGrn] = await getGrns(erpPool, { vchCodes: [saved.vchCode] });
    if (busyGrn && !reused && Math.abs(busyGrn.amount - grn.total) > 0.5) {
      warnings.push(`Busy's total for ${saved.vchNo} is ${busyGrn.amount}, expected ${grn.total} — check it in Busy.`);
    }

    // Close the delivery here exactly like linking a GRN made in Busy.
    const outcome = await linkEntryToGrn(pool, erpPool, {
      entryId, grnVchCode: saved.vchCode, userId: req.user.userId, method: 'ReceivedHere',
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    if (!outcome.ok) {
      return res.status(500).json({ error: `${saved.vchNo} was saved in Busy but could not be linked here: ${outcome.error}. Link it on the Busy Receiving page.`, grnNo: saved.vchNo });
    }
    // Record which PO line each item came in against (the oldest when several).
    for (const l of grn.lines) {
      await pool.request()
        .input('id', sql.BigInt, l.entryItemId)
        .input('ref', sql.Int, l.refCode)
        .input('poNo', sql.NVarChar(40), l.poNo.slice(0, 40))
        .query('UPDATE dbo.DeliveryEntryItems SET BusyPORefCode = @ref, BusyPONo = @poNo WHERE EntryItemId = @id');
    }

    await writeAuditLog({
      entityType: 'DeliveryEntry', entityId: entryId, action: reused ? 'LinkPushedGRN' : 'ReceivedInBusy',
      userId: req.user.userId,
      newValues: {
        busyGrnNo: saved.vchNo, busyGrnVchCode: saved.vchCode, taxType: grn.taxType, expectedTotal: grn.total,
        busyTotal: busyGrn?.amount ?? null, lines: grn.lines.map((l) => ({
          item: l.itemName, qty: l.qty, batch: l.batchNo, allowance: l.allowance || 0,
          listPrice: l.listPrice, rejectionPct: l.discountPct, qaRejectionPct: l.qaRejectionPct, price: l.price,
          pos: l.refs.map((r) => ({ po: r.poNo, ref: r.refCode, qty: r.qty })),
        })),
      },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ entryId, entryNo: grn.entryNo, grnNo: saved.vchNo, vchCode: saved.vchCode, reused, warnings });
  } catch (err) {
    next(err);
  } finally {
    if (locked) pushesInFlight.delete(entryId);
  }
});

// ── Rejection % on a GRN already saved from here (2026-10-29) ────────────────
//   GET  /:entryId/rejection?pct=   what the GRN becomes (blank pct = QA's), nothing saved
//   POST /:entryId/rejection        { rejectionPct, reason } → GRN changed in place in Busy
router.get('/:entryId/rejection', authenticate, authorize(...RECEIVE_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const erpPool = await getErpPool();
    const out = await buildGrnRejectionAmend(pool, erpPool, {
      entryId: parseInt(req.params.entryId, 10), rejectionPct: req.query.pct, seriesName: config.busyCom.grnSeriesName,
    });
    delete out.xml;
    res.json({ enabled: config.busyCom.grnEnabled, ...out });
  } catch (err) { next(err); }
});

router.post('/:entryId/rejection', authenticate, authorize(...RECEIVE_ROLES), async (req, res, next) => {
  const entryId = parseInt(req.params.entryId, 10);
  let locked = false;
  try {
    if (!config.busyCom.grnEnabled) return res.status(503).json({ error: NOT_ENABLED });
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Give the reason for the change' });
    if (pushesInFlight.has(entryId)) return res.status(409).json({ error: 'This GRN is already being changed in Busy — wait a moment.' });
    pushesInFlight.add(entryId);
    locked = true;

    const pool = await getPool();
    const erpPool = await getErpPool();
    const busyUser = await getReceivingBusyUser(pool, erpPool, req.user.userId);
    if (!busyUser) return res.status(403).json({ error: BUSY_LINK_PROBLEM, needsBusyLink: true });

    const g = await buildGrnRejectionAmend(pool, erpPool, { entryId, rejectionPct: req.body.rejectionPct, seriesName: config.busyCom.grnSeriesName });
    if (g.problems.length) return res.status(422).json({ error: g.problems[0], problems: g.problems });

    const saved = await busyBridge.modifyVoucher(GRN_VCHTYPE, g.vchCode, g.xml);
    if (!saved.ok) {
      logger.warn(`[BusyGrn] Busy refused the rejection change to ${g.grnNo}: ${saved.error}`);
      return res.status(502).json({ error: `Busy did not save the change: ${saved.error}` });
    }
    logger.info(`[BusyGrn] ${g.grnNo} (VchCode ${g.vchCode}) rejection ${g.rejectionPct}% applied by user ${req.user.userId}`);

    const warnings = [];
    try {
      await attributeToBusyUser(erpPool, { vchCode: g.vchCode, vchNo: g.grnNo, busyUserName: busyUser });
    } catch (err) {
      warnings.push(`${g.grnNo} shows the change as made by Supervisor in Busy.`);
      logger.error(`[BusyGrn] Could not set Busy user on ${g.grnNo}: ${err.message}`);
    }
    // Busy must still hold every PO reference, and the total we worked out.
    const refs = await grnPoRefs(erpPool, g.vchCode);
    const lost = g.lines.flatMap((l) => l.refs).filter((r) => !refs.some((x) => x.RefCode === r.refCode));
    if (lost.length) warnings.push(`Busy dropped the PO link to ${lost.map((r) => r.poNo).join(', ')} — open ${g.grnNo} in Busy and pick the PO again.`);
    const [after] = await getGrns(erpPool, { vchCodes: [g.vchCode] });
    if (after && Math.abs(after.amount - g.total) > 0.5) warnings.push(`Busy's total for ${g.grnNo} is ${after.amount}, expected ${g.total} — check it in Busy.`);

    await writeAuditLog({
      entityType: 'DeliveryEntry', entityId: entryId, action: 'GRNRejectionApplied', userId: req.user.userId,
      oldValues: { busyGrnNo: g.grnNo, total: g.currentTotal, prices: g.lines.map((l) => ({ item: l.itemName, price: l.currentPrice })) },
      newValues: {
        busyGrnNo: g.grnNo, rejectionPct: g.rejectionPct, qaRejectionPct: g.qaRejectionPct, reason, expectedTotal: g.total, busyTotal: after?.amount ?? null,
        lines: g.lines.map((l) => ({ item: l.itemName, qty: l.qty, listPrice: l.listPrice, price: l.price, amount: l.amount })),
      },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ grnNo: g.grnNo, rejectionPct: g.rejectionPct, oldTotal: g.currentTotal, total: after?.amount ?? g.total, warnings });
  } catch (err) {
    next(err);
  } finally {
    if (locked) pushesInFlight.delete(entryId);
  }
});

// ── GET /:entryId/print ──────────────────────────────────────────────────────
router.get('/:entryId/print', authenticate, async (req, res, next) => {
  try {
    const entryId = parseInt(req.params.entryId, 10);
    const pool = await getPool();
    const entry = (await pool.request().input('id', sql.Int, entryId).query(`
      SELECT de.EntryId, de.EntryNo, de.Status, de.DeliveryDate, de.DeliveryTime, de.CreatedAt AS GateAt,
             de.VehicleRegNo, de.DriverName, de.DriverIdNo, de.Notes, de.Destination, de.NetWeight,
             de.PurchaseOrderNo, de.NonPOReason, de.BusyGRNVchCode, de.BusyGRNNo, de.BusyGRNLinkMethod, de.BusyGRNLinkedAt,
             s.SupplierName, s.SupplierCode, gu.FullName AS GateBy,
             g.GRNNo, g.ReceivedAt, ru.FullName AS ReceivedBy, lu.FullName AS LinkedBy, sl.LocationName
      FROM dbo.DeliveryEntries de
      JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      LEFT JOIN dbo.Users gu ON gu.UserId = de.CreatedBy
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId AND g.GRNStatus <> 'Reversed'
      LEFT JOIN dbo.Users ru ON ru.UserId = g.ReceivedBy
      LEFT JOIN dbo.Users lu ON lu.UserId = de.BusyGRNLinkedBy
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = de.LocationId
      WHERE de.EntryId = @id`)).recordset[0];
    if (!entry) return res.status(404).json({ error: 'Delivery not found' });

    const [weighings, qa] = await Promise.all([
      pool.request().input('id', sql.Int, entryId).query(`
        SELECT wr.TicketNo, wr.FirstWeight, wr.SecondWeight, wr.NetWeight, wr.BagWeight, wr.FinalNetWeight, wr.WeighmentDate,
               m.MaterialName, u.FullName AS OperatorName
        FROM dbo.WeighbridgeRecords wr
        LEFT JOIN dbo.DeliveryEntryItems dei ON dei.EntryItemId = wr.EntryItemId
        LEFT JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
        LEFT JOIN dbo.Users u ON u.UserId = wr.OperatorId
        WHERE wr.EntryId = @id ORDER BY wr.WeighbridgeId`),
      pool.request().input('id', sql.Int, entryId).query(`
        SELECT TOP 1 qi.InspectionNo, qi.OverallStatus, qi.AcceptedQty, qi.RejectedQty, qi.OverallRemarks, qi.InspectionDate,
               u.FullName AS InspectorName, ua.FullName AS ApprovedByName, qi.ApprovedAt
        FROM dbo.QAInspections qi LEFT JOIN dbo.Users u ON u.UserId = qi.InspectorId LEFT JOIN dbo.Users ua ON ua.UserId = qi.ApprovedBy
        WHERE qi.EntryId = @id ORDER BY qi.InspectionId DESC`),
    ]);

    const erpPool = await getErpPool();
    let busyGrn = null;
    if (entry.BusyGRNVchCode) [busyGrn] = await getGrns(erpPool, { vchCodes: [entry.BusyGRNVchCode] });
    if (!busyGrn && entry.GRNNo) [busyGrn] = await getGrns(erpPool, { grnNos: [String(entry.GRNNo).replace(/\s*\(\d+\)$/, '')] });
    if (!busyGrn) return res.status(404).json({ error: `${entry.EntryNo} has not been received in Busy yet — there is no GRN to print.` });

    const vch = busyGrn.vchCode;
    const [extra, batches, addedBy, life] = await Promise.all([
      erpPool.request().input('v', erpSql.Int, vch).query(`
        SELECT LTRIM(RTRIM(st.Name)) AS TaxType, LTRIM(RTRIM(oi.OF1)) AS OF1
        FROM dbo.Tran1 t1 LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1 LEFT JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
        WHERE t1.VchCode = @v`),
      erpPool.request().input('v', erpSql.Int, vch).query(`
        SELECT MasterCode1 AS ItemCode, ItemSrNo, LTRIM(RTRIM(No)) AS BatchNo FROM dbo.Tran3 WHERE VchCode = @v AND RecType = 2`),
      // Busy's "Added by" (BusyUserLog lives in the company DB, not the year DB).
      erpPool.request().input('v', erpSql.Int, vch).query(`
        SELECT TOP 1 LTRIM(RTRIM(CAST(UserName AS NVARCHAR(100)))) AS UserName
        FROM [${process.env.BUSY_COMPANY_DB || String(config.erpDb.database).replace(/1\d{4}$/, '')}].dbo.BusyUserLog
        WHERE WorkedOn = 2 AND LogFor = 1 AND L1 = @v`).catch(() => ({ recordset: [] })),
      getGrnLifecycle(erpPool, [vch]),
    ]);
    const batchOf = (line) => batches.recordset.find((b) => b.ItemCode === line.itemCode && (!b.ItemSrNo || b.ItemSrNo === line.srNo))?.BatchNo || null;
    // Director approval for payment (2026-11-11) — printed on the GRN instead of a signature
    const approval = (await pool.request().input('v', sql.Int, vch).query(`
      SELECT a.Status, a.ApprovedAt, a.ApprovedAmount, a.ChangedAfterApproval, a.QueryReason, u.FullName AS ApprovedBy
      FROM dbo.GrnApprovals a LEFT JOIN dbo.Users u ON u.UserId = a.ApprovedBy WHERE a.GrnVchCode = @v`)
      .catch(() => ({ recordset: [] }))).recordset[0] || null;
    // The flagged checks and the GRN Reviewer's reason on each (2026-11-23)
    if (approval) {
      try {
        const ga = require('../services/grn-approval.service');
        const [trail, reasons] = await Promise.all([ga.loadTrail(pool, erpPool, [vch]), ga.loadReasons(pool, [vch])]);
        approval.checks = ga.withReasons(ga.checksFor(approval, trail.get(vch)), reasons.get(vch))
          .filter((w) => w.level !== 'info').map((w) => ({ text: w.text, level: w.level, reason: w.reason?.reason || null, reasonBy: w.reason?.by || null }));
      } catch (e) { approval.checks = []; }
    }
    const linesTotal = Math.round(busyGrn.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    res.json({
      entry,
      weighings: weighings.recordset,
      qa: qa.recordset[0] || null,
      grn: {
        ...busyGrn,
        taxType: extra.recordset[0]?.TaxType || null,
        ticketNo: extra.recordset[0]?.OF1 || null,
        addedBy: addedBy.recordset[0]?.UserName || null,
        lines: busyGrn.lines.map((l) => ({ ...l, batchNo: batchOf(l) })),
        linesTotal,
        taxAndRounding: Math.round((busyGrn.amount - linesTotal) * 100) / 100,
      },
      billing: life[vch] || null,
      approval,
      printedAt: new Date(),
      printedBy: req.user.fullName || req.user.username || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
