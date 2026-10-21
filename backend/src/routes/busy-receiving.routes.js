/**
 * Busy Receiving Routes (2026-10-17) — Phase 0 / Phase 1 of the gate → GRN
 * integration with Busy ERP. Everything here READS Busy; the only writes
 * are to this system's own database.
 *
 * Phase 0 (one source of master data, clean up the backlog)
 *   GET  /open-po-lines?supplierId=      Busy PO lines still pending for a supplier (weighbridge PO picker, gate suggestions)
 *   GET  /items?search=                  Busy items (gate material picker)
 *   GET  /open-entries                   open gate entries + suggested Busy GRN for each
 *   POST /entries/:entryId/link-grn      link one entry to the Busy GRN it was received on
 *   POST /entries/link-high-confidence   link every High-confidence suggestion
 *   POST /entries/:entryId/cancel        close an entry that never became a GRN
 *   GET  /supplier-cleanup               gate-created suppliers + likely Busy supplier
 *   POST /supplier-cleanup/merge         move a gate-created supplier's records onto the Busy supplier
 *
 * Phase 1 (follow Busy)
 *   GET  /po-tracker                     approved POs not fully received (+ at the gate now)
 *   GET  /grns-without-entry?from=&to=   Busy GRNs with no gate entry here (bypass report)
 *   GET  /accounts/unbilled-grns?since=  GRNs not yet billed
 *   GET  /accounts/unpaid-bills?since=   bills not fully paid, with GRN + PO behind each
 *   GET  /entries/:entryId/lifecycle     PO → gate → GRN → bill → paid for one delivery
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog, writeStatusHistory } = require('../services/audit.service');
const busy = require('../services/busy-receiving.service');
const link = require('../services/entry-grn-link.service');

const router = express.Router();

const VIEW_ROLES     = ['Admin', 'Supervisor', 'StoreReceiving', 'FactoryReceiving', 'Procurement', 'Director', 'OpsManager'];
// Weighbridge links each item to its Busy PO line (stage 2, since 2026-10-21).
const GATE_ROLES     = ['GateSecurity', 'Weighbridge', 'Admin', 'Supervisor', 'StoreReceiving', 'FactoryReceiving', 'Procurement'];
const LINK_ROLES     = ['Admin', 'Supervisor', 'StoreReceiving'];
const MERGE_ROLES    = ['Admin', 'Procurement'];
const ACCOUNTS_ROLES = ['Admin', 'Director', 'Procurement'];

const daysAgo = (n) => new Date(Date.now() - n * 864e5);
const parseDate = (v, fallback) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

// Short in-process cache for the heavier Busy reads (dashboards poll).
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function getSupplier(pool, supplierId) {
  const r = await pool.request().input('id', sql.Int, supplierId)
    .query('SELECT SupplierId, SupplierCode, SupplierName FROM dbo.Suppliers WHERE SupplierId = @id');
  return r.recordset[0] || null;
}

/**
 * Quantity per Busy PO line (RefCode) already on a truck that's in the gate
 * pipeline here — delivered but not yet GRN'd in Busy.
 */
async function qtyAtGateByRefCode(pool, refCodes) {
  if (!refCodes.length || !(await link.hasLinkColumns(pool))) return {};
  const req = pool.request();
  refCodes.forEach((r, i) => req.input(`r${i}`, sql.Int, r));
  const result = await req.query(`
    SELECT dei.BusyPORefCode, SUM(ISNULL(dei.Quantity, 0)) AS Qty, COUNT(*) AS Trucks,
           STRING_AGG(de.EntryNo, ', ') AS EntryNos
    FROM dbo.DeliveryEntryItems dei
    JOIN dbo.DeliveryEntries de ON de.EntryId = dei.EntryId
    WHERE dei.BusyPORefCode IN (${refCodes.map((_, i) => `@r${i}`).join(',')})
      AND de.Status NOT IN (${link.CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})
    GROUP BY dei.BusyPORefCode`);
  return Object.fromEntries(result.recordset.map((r) => [r.BusyPORefCode, { qty: Number(r.Qty) || 0, trucks: r.Trucks, entryNos: r.EntryNos }]));
}

// ── Phase 0: gate pickers ────────────────────────────────────────────────────

router.get('/open-po-lines', authenticate, authorize(...GATE_ROLES), async (req, res, next) => {
  try {
    const supplierId = parseInt(req.query.supplierId, 10);
    if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });
    const pool = await getPool();
    const supplier = await getSupplier(pool, supplierId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const partyCode = link.busyPartyCode(supplier.SupplierCode);
    if (!partyCode) {
      return res.json({ busySupplier: false, lines: [], message: `"${supplier.SupplierName}" is not a Busy supplier — pick the supplier's Busy account.` });
    }
    const lines = await busy.getOpenPoLines(await getErpPool(), { partyCode });
    const atGate = await qtyAtGateByRefCode(pool, lines.map((l) => l.refCode));
    res.json({
      busySupplier: true,
      lines: lines.map((l) => ({ ...l, atGate: atGate[l.refCode] || null })),
    });
  } catch (err) { next(err); }
});

router.get('/items', authenticate, authorize(...GATE_ROLES), async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 2) return res.json([]);
    res.json(await busy.searchBusyItems(await getErpPool(), search));
  } catch (err) { next(err); }
});

// ── Phase 0: link the backlog of open gate entries to Busy GRNs ──────────────

router.get('/open-entries', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const results = await link.suggestLinks(pool, await getErpPool());
    res.json({
      migrationApplied: await link.hasLinkColumns(pool),
      entries: results.map(({ entry, suggestions }) => ({
        entryId: entry.EntryId,
        entryNo: entry.EntryNo,
        status: entry.Status,
        deliveryDate: entry.DeliveryDate,
        vehicle: entry.VehicleRegNo,
        supplierId: entry.SupplierId,
        supplierName: entry.SupplierName,
        supplierCode: entry.SupplierCode,
        busySupplier: !!entry.partyCode,
        ticketNo: entry.TicketNo,
        netWeight: entry.NetWeight,
        items: entry.items.map((i) => ({ name: i.MaterialName, qty: i.Quantity })),
        suggestions,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/entries/:entryId/link-grn', authenticate, authorize(...LINK_ROLES), async (req, res, next) => {
  try {
    const outcome = await link.linkEntryToGrn(await getPool(), await getErpPool(), {
      entryId: parseInt(req.params.entryId, 10),
      grnVchCode: parseInt(req.body.grnVchCode, 10),
      allowPartyMismatch: req.body.allowPartyMismatch === true,
      allowShared: req.body.allowShared === true,
      method: 'Manual',
      userId: req.user.userId, ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error, code: outcome.code, linkedTo: outcome.linkedTo });
    res.status(201).json(outcome);
  } catch (err) { next(err); }
});

router.post('/entries/link-high-confidence', authenticate, authorize('Admin', 'Supervisor'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const erpPool = await getErpPool();
    if (!(await link.hasLinkColumns(pool))) return res.status(503).json({ error: link.MIGRATION_MISSING });
    const results = await link.suggestLinks(pool, erpPool);
    const linked = [];
    const failed = [];
    for (const { entry, suggestions } of results) {
      const top = suggestions[0];
      if (top?.confidence !== 'High') continue;
      const outcome = await link.linkEntryToGrn(pool, erpPool, {
        entryId: entry.EntryId, grnVchCode: top.grnVchCode, method: 'AutoVehicle',
        userId: req.user.userId, ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      (outcome.ok ? linked : failed).push({ entryNo: entry.EntryNo, grnNo: top.grnNo, error: outcome.error });
    }
    res.json({ linked, failed });
  } catch (err) { next(err); }
});

router.post('/entries/:entryId/cancel', authenticate, authorize(...LINK_ROLES), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters)' });
    const pool = await getPool();
    const [entry] = await link.loadOpenEntries(pool, { entryIds: [parseInt(req.params.entryId, 10)] });
    if (!entry) return res.status(409).json({ error: 'Entry not found or already closed / received' });
    await pool.request()
      .input('id', sql.Int, entry.EntryId)
      .input('notes', sql.NVarChar(500), `Cancelled: ${reason}`.slice(0, 500))
      .query(`UPDATE dbo.DeliveryEntries
              SET Status = 'Cancelled', Notes = LEFT(CONCAT(NULLIF(Notes, '') + ' | ', @notes), 500),
                  VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
              WHERE EntryId = @id`);
    writeStatusHistory({ entityType: 'DeliveryEntry', entityId: entry.EntryId, fromStatus: entry.Status, toStatus: 'Cancelled', changedBy: req.user.userId, remarks: reason });
    writeAuditLog({ entityType: 'DeliveryEntry', entityId: entry.EntryId, action: 'Cancel', userId: req.user.userId, oldValues: { status: entry.Status }, newValues: { status: 'Cancelled', reason }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
    res.json({ entryNo: entry.EntryNo, status: 'Cancelled' });
  } catch (err) { next(err); }
});

// ── Phase 0: supplier clean-up ───────────────────────────────────────────────

router.get('/supplier-cleanup', authenticate, authorize(...MERGE_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    if (!(await link.hasLinkColumns(pool))) return res.status(503).json({ error: link.MIGRATION_MISSING });

    // Gate-created suppliers (non-numeric code) that gate entries still
    // point at — whatever their IsLocalOnly / IsActive flags say: the gate's
    // farmer suppliers were flagged IsLocalOnly (so the supplier sync
    // wouldn't deactivate them), and the ones that weren't get deactivated
    // by that sync while their entries still reference them.
    const local = (await pool.request().query(`
      SELECT s.SupplierId, s.SupplierCode, s.SupplierName,
             (SELECT COUNT(*) FROM dbo.DeliveryEntries de WHERE de.SupplierId = s.SupplierId) AS Entries,
             (SELECT MAX(de.DeliveryDate) FROM dbo.DeliveryEntries de WHERE de.SupplierId = s.SupplierId) AS LastDelivery,
             (SELECT TOP 1 m.MaterialName FROM dbo.DeliveryEntries de
                JOIN dbo.DeliveryEntryItems i ON i.EntryId = de.EntryId JOIN dbo.Materials m ON m.MaterialId = i.MaterialId
               WHERE de.SupplierId = s.SupplierId ORDER BY de.EntryId DESC) AS LastMaterial
      FROM dbo.Suppliers s
      WHERE TRY_CAST(s.SupplierCode AS INT) IS NULL
        AND s.MergedIntoSupplierId IS NULL
        AND EXISTS (SELECT 1 FROM dbo.DeliveryEntries de WHERE de.SupplierId = s.SupplierId)
      ORDER BY Entries DESC, s.SupplierName`)).recordset;

    const busySuppliers = (await pool.request().query(`
      SELECT SupplierId, SupplierCode, SupplierName FROM dbo.Suppliers
      WHERE TRY_CAST(SupplierCode AS INT) IS NOT NULL AND ISNULL(IsActive, 1) = 1 AND MergedIntoSupplierId IS NULL`)).recordset;

    res.json(local.map((s) => ({
      supplierId: s.SupplierId,
      supplierCode: s.SupplierCode,
      supplierName: s.SupplierName,
      entries: s.Entries,
      lastDelivery: s.LastDelivery,
      lastMaterial: s.LastMaterial,
      candidates: busySuppliers
        .map((b) => ({ supplierId: b.SupplierId, supplierCode: b.SupplierCode, supplierName: b.SupplierName, similarity: link.nameSimilarity(s.SupplierName, b.SupplierName) }))
        .filter((c) => c.similarity >= 0.55)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 4)
        .map((c) => ({ ...c, similarity: Math.round(c.similarity * 100) / 100 })),
    })));
  } catch (err) { next(err); }
});

// Tables whose SupplierId follows a merge. SupplierCategories / SupplierEmails
// stay on the retired record (the Busy supplier keeps its own).
const SUPPLIER_REFS = [
  ['DeliveryEntries', 'SupplierId'],
  ['RFQDispatches', 'SupplierId'],
  ['Quotations', 'SupplierId'],
  ['RequisitionItems', 'PreferredSupplierId'],
  ['LPOReconciliation', 'SupplierId'],
  ['QuoteEvaluationItems', 'SupplierId'],
];

router.post('/supplier-cleanup/merge', authenticate, authorize(...MERGE_ROLES), async (req, res, next) => {
  try {
    const fromId = parseInt(req.body.fromSupplierId, 10);
    const toId = parseInt(req.body.toSupplierId, 10);
    if (!fromId || !toId || fromId === toId) return res.status(400).json({ error: 'fromSupplierId and a different toSupplierId are required' });
    const pool = await getPool();
    if (!(await link.hasLinkColumns(pool))) return res.status(503).json({ error: link.MIGRATION_MISSING });

    const from = await getSupplier(pool, fromId);
    const to = await getSupplier(pool, toId);
    if (!from || !to) return res.status(404).json({ error: 'Supplier not found' });
    if (link.busyPartyCode(from.SupplierCode)) return res.status(400).json({ error: `"${from.SupplierName}" is a Busy supplier — only gate-created suppliers can be merged away` });
    if (!link.busyPartyCode(to.SupplierCode)) return res.status(400).json({ error: `"${to.SupplierName}" is not a Busy supplier` });

    const tx = new sql.Transaction(pool);
    await tx.begin();
    const moved = {};
    try {
      for (const [table, col] of SUPPLIER_REFS) {
        const r = await new sql.Request(tx).input('from', sql.Int, fromId).input('to', sql.Int, toId)
          .query(`UPDATE dbo.${table} SET ${col} = @to WHERE ${col} = @from`);
        if (r.rowsAffected[0]) moved[table] = r.rowsAffected[0];
      }
      await new sql.Request(tx).input('from', sql.Int, fromId).input('to', sql.Int, toId)
        .query('UPDATE dbo.Suppliers SET IsActive = 0, MergedIntoSupplierId = @to WHERE SupplierId = @from');
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      if (err.number === 2627 || err.number === 2601) {
        return res.status(409).json({ error: `Both suppliers already have a record on the same RFQ/quotation — merge needs a manual look (${err.message})` });
      }
      throw err;
    }

    writeAuditLog({
      entityType: 'Supplier', entityId: fromId, action: 'MergeIntoBusySupplier', userId: req.user.userId,
      oldValues: { supplierCode: from.SupplierCode, supplierName: from.SupplierName },
      newValues: { mergedInto: toId, busyCode: to.SupplierCode, busyName: to.SupplierName, moved },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ merged: from.SupplierName, into: to.SupplierName, moved });
  } catch (err) { next(err); }
});

// ── Phase 1: follow Busy ─────────────────────────────────────────────────────

router.get('/po-tracker', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const pos = await cached('po-tracker', 60_000, async () => busy.getPoTracker(await getErpPool()));
    const atGate = await qtyAtGateByRefCode(pool, pos.flatMap((p) => p.lines.map((l) => l.refCode)));
    res.json(pos.map((p) => {
      const gateLines = p.lines.filter((l) => atGate[l.refCode]);
      return {
        ...p,
        lines: p.lines.map((l) => ({ ...l, atGate: atGate[l.refCode] || null })),
        atGate: gateLines.length > 0,
        // On a truck here but not yet GRN'd in Busy beats "Not received".
        state: gateLines.length > 0 ? 'At the gate' : p.state,
      };
    }));
  } catch (err) { next(err); }
});

router.get('/grns-without-entry', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const from = parseDate(req.query.from, daysAgo(30));
    const to = parseDate(req.query.to, new Date());
    const pool = await getPool();
    const grns = await busy.getGrns(await getErpPool(), { since: from, until: to });
    const linkCols = await link.hasLinkColumns(pool);
    const linked = (await pool.request().query(`
      ${linkCols ? 'SELECT CAST(BusyGRNVchCode AS VARCHAR(20)) AS k FROM dbo.DeliveryEntries WHERE BusyGRNVchCode IS NOT NULL UNION ALL' : ''}
      SELECT LTRIM(RTRIM(GRNNo)) FROM dbo.GoodsReceiptNotes WHERE GRNStatus <> 'Reversed'`)).recordset.map((r) => r.k);
    const linkedSet = new Set(linked);
    res.json(grns.filter((g) => !linkedSet.has(String(g.vchCode)) && !linkedSet.has(g.grnNo)));
  } catch (err) { next(err); }
});

/** Our gate entry behind each Busy GRN, for the accounts views. */
async function entriesByGrn(pool, grns) {
  if (!grns.length) return {};
  const linkCols = await link.hasLinkColumns(pool);
  const req = pool.request();
  grns.forEach((g, i) => { req.input(`n${i}`, sql.VarChar(50), g.grnNo); req.input(`v${i}`, sql.Int, g.vchCode); });
  const result = await req.query(`
    SELECT de.EntryNo, LTRIM(RTRIM(g.GRNNo)) AS GRNNo, ${linkCols ? 'de.BusyGRNVchCode' : 'NULL AS BusyGRNVchCode'},
           (SELECT TOP 1 qi.OverallStatus FROM dbo.QAInspections qi WHERE qi.EntryId = de.EntryId ORDER BY qi.InspectionId DESC) AS QAStatus
    FROM dbo.GoodsReceiptNotes g JOIN dbo.DeliveryEntries de ON de.EntryId = g.EntryId
    WHERE g.GRNStatus <> 'Reversed' AND (g.GRNNo IN (${grns.map((_, i) => `@n${i}`).join(',')})
      ${linkCols ? `OR de.BusyGRNVchCode IN (${grns.map((_, i) => `@v${i}`).join(',')})` : ''})`);
  const out = {};
  for (const r of result.recordset) out[r.GRNNo] = { entryNo: r.EntryNo, qaStatus: r.QAStatus };
  return out;
}

router.get('/accounts/unbilled-grns', authenticate, authorize(...ACCOUNTS_ROLES), async (req, res, next) => {
  try {
    const since = parseDate(req.query.since, daysAgo(90));
    const grns = await cached(`unbilled:${since.toISOString().slice(0, 10)}`, 60_000,
      async () => busy.getUnbilledGrns(await getErpPool(), { since }));
    const gate = await entriesByGrn(await getPool(), grns);
    res.json(grns.map((g) => ({ ...g, gateEntry: gate[g.grnNo] || null })));
  } catch (err) { next(err); }
});

router.get('/accounts/unpaid-bills', authenticate, authorize(...ACCOUNTS_ROLES), async (req, res, next) => {
  try {
    const since = parseDate(req.query.since, daysAgo(90));
    const bills = await cached(`unpaid:${since.toISOString().slice(0, 10)}`, 60_000,
      async () => busy.getUnpaidBills(await getErpPool(), { since }));
    const gate = await entriesByGrn(await getPool(), bills.flatMap((b) => b.grns));
    res.json(bills.map((b) => ({ ...b, grns: b.grns.map((g) => ({ ...g, gateEntry: gate[g.grnNo] || null })) })));
  } catch (err) { next(err); }
});

router.get('/entries/:entryId/lifecycle', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const linkCols = await link.hasLinkColumns(pool);
    const entry = (await pool.request().input('id', sql.Int, parseInt(req.params.entryId, 10)).query(`
      SELECT de.EntryId, de.EntryNo, de.Status, de.DeliveryDate, s.SupplierName,
             ${linkCols ? 'de.BusyGRNVchCode, de.BusyGRNNo, de.BusyGRNLinkMethod' : 'NULL AS BusyGRNVchCode, NULL AS BusyGRNNo, NULL AS BusyGRNLinkMethod'},
             g.GRNNo
      FROM dbo.DeliveryEntries de JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId AND g.GRNStatus <> 'Reversed'
      WHERE de.EntryId = @id`)).recordset[0];
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const erpPool = await getErpPool();
    let grn = null;
    if (entry.BusyGRNVchCode) [grn] = await busy.getGrns(erpPool, { vchCodes: [entry.BusyGRNVchCode] });
    if (!grn && entry.GRNNo) [grn] = await busy.getGrns(erpPool, { grnNos: [entry.GRNNo] });

    let poLines = [];
    if (linkCols) {
      const refs = (await pool.request().input('id', sql.Int, entry.EntryId)
        .query('SELECT DISTINCT BusyPORefCode FROM dbo.DeliveryEntryItems WHERE EntryId = @id AND BusyPORefCode IS NOT NULL'))
        .recordset.map((r) => r.BusyPORefCode);
      if (refs.length) poLines = await busy.getOpenPoLines(erpPool, { refCodes: refs });
    }

    const life = grn ? (await busy.getGrnLifecycle(erpPool, [grn.vchCode]))[grn.vchCode] : null;
    res.json({
      entry: { entryNo: entry.EntryNo, status: entry.Status, deliveryDate: entry.DeliveryDate, supplier: entry.SupplierName, linkMethod: entry.BusyGRNLinkMethod },
      busyGrn: grn,
      billed: life?.billed || null,
      paid: life?.paid || null,
      bills: life?.bills || [],
      // PO lines this truck delivered against that are STILL pending in Busy
      // (fully received lines drop out).
      pendingPoLines: poLines,
    });
  } catch (err) { next(err); }
});

module.exports = router;
