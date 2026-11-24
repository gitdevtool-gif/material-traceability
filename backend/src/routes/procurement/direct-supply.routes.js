/**
 * Direct-supply orders & delivery plan (2026-11-24) — see
 * services/direct-supply.service.js.
 *
 *   GET  /items                       configured direct-supply items
 *   GET  /orders?item=&all=           Busy POs for the item: ordered / received / balance
 *   GET  /plan?item=&from=&to=        plan + arrivals (gate, Busy GRN) per day × supplier
 *   PUT  /plan                        { item, planDate, supplierId, plannedQty, trucks, notes, busyPurOrdNo }
 *   POST /plan/copy                   { item, fromStart, toStart, days }  repeat a week's plan
 *
 * Procurement raises the POs (busy-lpo /direct-push); the production side
 * decides which supplier delivers on which day. Everyone who handles the
 * trucks (gate, weighbridge, stores, F8) can see the plan.
 */
const express = require('express');
const { sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { writeAuditLog } = require('../../services/audit.service');
const ds = require('../../services/direct-supply.service');

const router = express.Router();

const VIEW_ROLES = [
  'Admin', 'Procurement', 'Director', 'ProductionManager', 'HeadOfProductionPlanning', 'OpsManager',
  'Weighbridge', 'GateSecurity', 'StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'ProductionClerk',
];
const PLAN_ROLES = ['Admin', 'Director', 'ProductionManager', 'HeadOfProductionPlanning', 'OpsManager'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOk = (d) => DAY_RE.test(String(d || '')) && !Number.isNaN(new Date(`${d}T00:00:00`).getTime());
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ds.isoDay(x); };
const today = () => ds.isoDay(new Date());

/** The requested item if it is a configured direct-supply item (default: the first one). */
async function pickItem(name) {
  const items = await ds.getDirectSupplyItems();
  if (!items.length) return { error: 'No direct-supply items are set up (System Settings).' };
  const wanted = name ? await ds.directItemFor(name) : items[0];
  if (!wanted) return { error: `"${name}" is not a direct-supply item.` };
  const erpPool = await ds.getErpPool();
  const item = await ds.resolveItem(erpPool, wanted);
  if (!item) return { error: `Item "${wanted}" does not exist in Busy.` };
  return { item, items, erpPool };
}

router.get('/items', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const items = await ds.getDirectSupplyItems();
    const erpPool = await ds.getErpPool();
    const resolved = await Promise.all(items.map(async (n) => {
      const it = await ds.resolveItem(erpPool, n);
      return { name: n, inBusy: !!it, code: it?.Code || null, unit: it?.Unit || null };
    }));
    res.json({ items: resolved, canPlan: PLAN_ROLES.includes(req.user.role) });
  } catch (err) { next(err); }
});

router.get('/orders', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const picked = await pickItem(req.query.item);
    if (picked.error) return res.status(400).json({ error: picked.error });
    const pool = await ds.getPool();
    const orders = await ds.openOrders(pool, picked.erpPool, picked.item, { includeClosed: req.query.all === '1', includeStale: true });
    const bySupplier = new Map();
    for (const o of orders.filter((x) => x.open)) {
      const k = o.supplierId || `p${o.partyCode}`;
      const e = bySupplier.get(k) || { supplierId: o.supplierId, supplierName: o.supplierName, partyCode: o.partyCode, pos: 0, ordered: 0, received: 0, balance: 0 };
      e.pos += 1; e.ordered += o.ordered; e.received += o.received; e.balance += o.balance;
      bySupplier.set(k, e);
    }
    const r3 = (n) => Math.round(n * 1000) / 1000;
    res.json({
      item: { code: picked.item.Code, name: picked.item.Name, unit: picked.item.Unit },
      orders,
      bySupplier: [...bySupplier.values()].map((e) => ({ ...e, ordered: r3(e.ordered), received: r3(e.received), balance: r3(e.balance) }))
        .sort((a, b) => b.balance - a.balance),
      totals: {
        open: orders.filter((o) => o.open).length,
        balance: r3(orders.filter((o) => o.open).reduce((s, o) => s + o.balance, 0)),
        stale: orders.filter((o) => o.stale).length,
        staleBalance: r3(orders.filter((o) => o.stale).reduce((s, o) => s + o.balance, 0)),
      },
    });
  } catch (err) { next(err); }
});

router.get('/plan', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const picked = await pickItem(req.query.item);
    if (picked.error) return res.status(400).json({ error: picked.error });
    const from = dayOk(req.query.from) ? req.query.from : today();
    let to = dayOk(req.query.to) ? req.query.to : addDays(from, 6);
    if (to < from) to = from;
    if (addDays(from, 41) < to) to = addDays(from, 41); // at most 6 weeks at a time
    const pool = await ds.getPool();
    const [plan, actuals, orders, standing] = await Promise.all([
      ds.loadPlan(pool, picked.item.Name, from, to),
      ds.loadActuals(pool, picked.erpPool, picked.item, from, to),
      ds.openOrders(pool, picked.erpPool, picked.item),
      ds.standingSuppliers(pool, picked.erpPool, picked.item),
    ]);

    // Rows: suppliers with an open PO, then anyone planned or delivering in
    // the range, then the rest of the standing suppliers.
    const rows = new Map();
    const addRow = (id, name, extra = {}) => {
      if (!id) return;
      const r = rows.get(id) || { supplierId: id, supplierName: name, openBalance: 0, openPos: [], standing: false };
      Object.assign(r, extra);
      rows.set(id, r);
    };
    for (const o of orders) {
      if (!o.supplierId) continue;
      addRow(o.supplierId, o.supplierName);
      const r = rows.get(o.supplierId);
      r.openBalance = Math.round((r.openBalance + o.balance) * 1000) / 1000;
      r.openPos.push({ ordno: o.ordno, balance: o.balance, ordered: o.ordered, date: o.date, approvalLabel: o.approvalLabel });
    }
    for (const p of plan) addRow(p.SupplierId, p.SupplierName);
    const actualList = [...actuals.byKey.values()];
    const supplierNames = new Map(standing.filter((s) => s.supplierId).map((s) => [s.supplierId, s.supplierName]));
    for (const a of actualList) addRow(a.supplierId, supplierNames.get(a.supplierId) || `Supplier ${a.supplierId}`);
    for (const s of standing) {
      if (!s.supplierId) continue;
      addRow(s.supplierId, s.supplierName, { standing: true, standingPrice: s.standingPrice, taxType: s.taxType, phone: s.phone });
    }
    // Names for suppliers only seen at the gate (not standing in Busy)
    const missing = [...rows.values()].filter((r) => /^Supplier \d+$/.test(r.supplierName)).map((r) => r.supplierId);
    if (missing.length) {
      const q = pool.request();
      missing.forEach((id, i) => q.input(`s${i}`, sql.Int, id));
      const names = (await q.query(`SELECT SupplierId, SupplierName FROM dbo.Suppliers WHERE SupplierId IN (${missing.map((_, i) => `@s${i}`).join(',')})`)).recordset;
      names.forEach((n) => { rows.get(n.SupplierId).supplierName = n.SupplierName; });
    }

    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    res.json({
      item: { code: picked.item.Code, name: picked.item.Name, unit: picked.item.Unit },
      items: picked.items,
      from, to, today: today(), days,
      rows: [...rows.values()].sort((a, b) => (b.openBalance > 0) - (a.openBalance > 0) || a.supplierName.localeCompare(b.supplierName)),
      plan,
      actuals: actualList,
      unmatchedGrns: actuals.unmatchedGrns.length,
      canPlan: PLAN_ROLES.includes(req.user.role),
    });
  } catch (err) { next(err); }
});

async function validateCell(pool, erpPool, item, body) {
  const planDate = String(body.planDate || '');
  if (!dayOk(planDate)) return { error: 'planDate must be yyyy-mm-dd' };
  if (planDate < addDays(today(), -7)) return { error: 'Plans more than a week old cannot be changed.' };
  if (planDate > addDays(today(), 90)) return { error: 'Plan at most 90 days ahead.' };
  const supplierId = parseInt(body.supplierId, 10);
  if (!supplierId) return { error: 'supplierId is required' };
  const sup = (await pool.request().input('id', sql.Int, supplierId)
    .query('SELECT SupplierId, SupplierName, SupplierCode, IsActive FROM dbo.Suppliers WHERE SupplierId = @id')).recordset[0];
  if (!sup) return { error: 'Supplier not found' };
  const num = (v, max, label) => {
    if (v === '' || v == null) return { v: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) return { error: `${label} must be between 0 and ${max}` };
    return { v: n };
  };
  const qty = num(body.plannedQty, 500, 'Planned quantity');
  if (qty.error) return qty;
  const trucks = num(body.trucks, 50, 'Trucks');
  if (trucks.error) return trucks;
  if (trucks.v != null && !Number.isInteger(trucks.v)) return { error: 'Trucks must be a whole number' };
  const notes = String(body.notes || '').trim().slice(0, 300) || null;
  let busyPurOrdNo = String(body.busyPurOrdNo || '').trim() || null;
  if (busyPurOrdNo) {
    const code = parseInt(String(sup.SupplierCode || '').trim(), 10);
    const theirs = Number.isFinite(code) ? await ds.loadBusyOrders(erpPool, item.Code, { partyCode: code }) : [];
    if (!theirs.some((o) => o.ordno === busyPurOrdNo)) return { error: `${busyPurOrdNo} is not a ${item.Name} PO of ${sup.SupplierName}.` };
  }
  const remove = body.remove === true;
  if (!remove && !sup.IsActive) return { error: `${sup.SupplierName} is inactive.` };
  return { planDate, supplierId, supplier: sup, plannedQty: qty.v, trucks: trucks.v, notes, busyPurOrdNo, remove };
}

router.put('/plan', authenticate, authorize(...PLAN_ROLES), async (req, res, next) => {
  try {
    const picked = await pickItem(req.body.item);
    if (picked.error) return res.status(400).json({ error: picked.error });
    const pool = await ds.getPool();
    const cell = await validateCell(pool, picked.erpPool, picked.item, req.body);
    if (cell.error) return res.status(400).json({ error: cell.error });
    const result = await ds.savePlanCell(pool, { ...cell, itemName: picked.item.Name, userId: req.user.userId });
    await writeAuditLog({
      entityType: 'DirectSupplyPlan', entityId: `${picked.item.Code}|${cell.planDate}|${cell.supplierId}`,
      action: result.deleted ? 'Delete' : (result.saved?.Action === 'INSERT' ? 'Create' : 'Update'),
      userId: req.user.userId,
      oldValues: result.deleted || undefined,
      newValues: result.saved ? { supplier: cell.supplier.SupplierName, planDate: cell.planDate, plannedQty: cell.plannedQty, trucks: cell.trucks, notes: cell.notes, busyPurOrdNo: cell.busyPurOrdNo } : undefined,
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ ok: true, deleted: !!result.deleted, saved: result.saved || null });
  } catch (err) { next(err); }
});

// Repeat a run of days (default 7) onto another start date — "same as last
// week". Only days with nothing planned yet are filled; nothing is overwritten.
router.post('/plan/copy', authenticate, authorize(...PLAN_ROLES), async (req, res, next) => {
  try {
    const picked = await pickItem(req.body.item);
    if (picked.error) return res.status(400).json({ error: picked.error });
    const { fromStart, toStart } = req.body;
    const days = Math.min(42, Math.max(1, parseInt(req.body.days, 10) || 7));
    if (!dayOk(fromStart) || !dayOk(toStart)) return res.status(400).json({ error: 'fromStart and toStart must be yyyy-mm-dd' });
    if (toStart < today()) return res.status(400).json({ error: 'Copy onto today or later only.' });
    const pool = await ds.getPool();
    const source = await ds.loadPlan(pool, picked.item.Name, fromStart, addDays(fromStart, days - 1));
    const target = await ds.loadPlan(pool, picked.item.Name, toStart, addDays(toStart, days - 1));
    const taken = new Set(target.map((t) => `${t.PlanDate}|${t.SupplierId}`));
    const offset = Math.round((new Date(`${toStart}T00:00:00`) - new Date(`${fromStart}T00:00:00`)) / 86400000);
    let copied = 0;
    let skipped = 0;
    for (const s of source) {
      const d = addDays(s.PlanDate, offset);
      if (taken.has(`${d}|${s.SupplierId}`)) { skipped += 1; continue; }
      // the PO it pointed at may be finished by now — the new days don't name one
      await ds.savePlanCell(pool, {
        planDate: d, itemName: picked.item.Name, supplierId: s.SupplierId, plannedQty: s.PlannedQty,
        trucks: s.Trucks, notes: s.Notes, busyPurOrdNo: null, userId: req.user.userId,
      });
      copied += 1;
    }
    await writeAuditLog({
      entityType: 'DirectSupplyPlan', entityId: `${picked.item.Code}|${toStart}`, action: 'Create', userId: req.user.userId,
      newValues: { event: 'CopyPlan', fromStart, toStart, days, copied, skipped },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ copied, skipped });
  } catch (err) { next(err); }
});

module.exports = router;
