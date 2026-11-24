/**
 * GRN Director approval + Accounts payments view (2026-11-11) — see
 * services/grn-approval.service.js.
 *
 *   GET  /summary                    counts for badges
 *   GET  /?status=Pending|NeedsReason|Queried|Approved|All&search=&from=&to=&flagged=1&page=&limit=
 *   GET  /accounts?view=ready|billed|paid|notApproved&search=&from=&to=
 *   GET  /:vchCode                   one GRN with its full trail and history
 *   POST /approve                    { items: [{ vchCode, signature }], note, override }   Director
 *   POST /:vchCode/reasons           { items: [{ key, reason }] }                GRN Reviewer (2026-11-23)
 *   POST /:vchCode/query             { reason }                                  Director
 *   POST /:vchCode/resubmit          { note }                                    Stores
 *   POST /sync                                                                   Admin
 */
const express = require('express');
const { getPool, sql } = require('../db');
const { getErpPool } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/audit.service');
const { sendSimpleEmail } = require('../services/email.service');
const config = require('../config');
const logger = require('../logger');
const svc = require('../services/grn-approval.service');

const router = express.Router();
const DIRECTOR_ROLES = ['Director', 'Admin'];
const STORES_ROLES = ['StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'Admin'];
// Gives the reason on each flagged check before the Director approves (2026-11-23)
const REVIEWER_ROLES = ['GrnReviewer', 'Admin'];
const VIEW_ROLES = [...new Set([...DIRECTOR_ROLES, ...STORES_ROLES, ...REVIEWER_ROLES, 'Accounts', 'Procurement', 'OpsManager', 'Auditor'])];
const ACCOUNTS_ROLES = ['Accounts', 'Director', 'Admin', 'Auditor'];
const SYNC_MAX_AGE_MS = 2 * 60_000;
const STATUSES = ['Pending', 'Queried', 'Approved', 'Deleted'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function syncQuietly(pool, erpPool) {
  try { await svc.syncGrnApprovals(pool, erpPool, { maxAgeMs: SYNC_MAX_AGE_MS }); } catch (err) { logger.warn(`[GrnApproval] sync failed: ${err.message}`); }
}

async function loadRows(pool, { status, search, from, to }) {
  const req = pool.request().input('start', sql.Date, svc.START_DATE);
  let where = 'a.GrnDate >= @start';
  if (status === 'Open') where += " AND a.Status IN ('Pending', 'Queried')";
  else if (status && status !== 'All') {
    if (!STATUSES.includes(status)) throw Object.assign(new Error('Unknown status'), { status: 400 });
    where += ' AND a.Status = @status'; req.input('status', sql.VarChar(20), status);
  } else where += " AND a.Status <> 'Deleted'";
  if (from) { where += ' AND a.GrnDate >= @from'; req.input('from', sql.Date, from); }
  if (to) { where += ' AND a.GrnDate <= @to'; req.input('to', sql.Date, to); }
  if (search) {
    where += ' AND (a.GrnNo LIKE @q OR a.PartyName LIKE @q OR de.EntryNo LIKE @q)';
    req.input('q', sql.NVarChar(100), `%${String(search).trim()}%`);
  }
  return (await req.query(`
    SELECT a.*, de.EntryNo, ua.FullName AS ApprovedByName, uq.FullName AS QueriedByName, ur.FullName AS ResubmittedByName
    FROM dbo.GrnApprovals a
    LEFT JOIN dbo.DeliveryEntries de ON de.EntryId = a.EntryId
    LEFT JOIN dbo.Users ua ON ua.UserId = a.ApprovedBy
    LEFT JOIN dbo.Users uq ON uq.UserId = a.QueriedBy
    LEFT JOIN dbo.Users ur ON ur.UserId = a.ResubmittedBy
    WHERE ${where}
    ORDER BY a.GrnDate DESC, a.GrnVchCode DESC`)).recordset;
}

/** loadTrail + the GRN Reviewer's reasons for these rows → shaped list */
async function shapeAll(pool, erpPool, rows) {
  const vchs = rows.map((r) => r.GrnVchCode);
  const [trail, reasons] = await Promise.all([svc.loadTrail(pool, erpPool, vchs), svc.loadReasons(pool, vchs)]);
  return rows.map((r) => shape(r, trail.get(r.GrnVchCode), reasons.get(r.GrnVchCode)));
}

// "Awaiting reason" count for the tab badge — needs the checks, so cached briefly.
let needsReasonCache = null;
async function needsReasonCount(pool, erpPool) {
  if (needsReasonCache && needsReasonCache.expires > Date.now()) return needsReasonCache.n;
  const rows = (await loadRows(pool, { status: 'Open' })).slice(0, 500);
  const n = (await shapeAll(pool, erpPool, rows)).filter((x) => x.awaitingReason > 0).length;
  needsReasonCache = { n, expires: Date.now() + 60_000 };
  return n;
}

function shape(r, t, reasons) {
  const g = t?.grn;
  const warnings = svc.withReasons(svc.checksFor(r, t), reasons);
  // Only open work waits for reasons; on an approved GRN the reasons are history.
  const open = ['Pending', 'Queried'].includes(r.Status);
  return {
    vchCode: r.GrnVchCode, grnNo: r.GrnNo, date: r.GrnDate, party: r.PartyName, amount: Number(r.Amount),
    status: r.Status, signature: t?.signature || r.Signature,
    approvedBy: r.ApprovedByName, approvedAt: r.ApprovedAt, approvedAmount: r.ApprovedAmount != null ? Number(r.ApprovedAmount) : null, approvalNote: r.ApprovalNote,
    queriedBy: r.QueriedByName, queriedAt: r.QueriedAt, queryReason: r.QueryReason,
    resubmittedBy: r.ResubmittedByName, resubmittedAt: r.ResubmittedAt, resubmitNote: r.ResubmitNote,
    changedAfterApproval: !!r.ChangedAfterApproval,
    entryId: r.EntryId, entryNo: r.EntryNo,
    ticketNo: t?.ticketNo || null,
    poNos: g?.poNos || [],
    items: g ? g.lines.map((l) => `${l.itemName} ${l.qty} ${l.unitName || ''} @ ${l.price}`.trim()) : [],
    busyApproved: g ? g.approved : null,
    qa: t?.entry?.qa || null,
    netKg: t?.entry?.netKg ?? null,
    warnings,
    flagged: warnings.some((w) => w.level !== 'info'),
    awaitingReason: open ? warnings.filter((w) => w.needsReason).length : 0,
    billed: t?.life.billed || null, paid: t?.life.paid || null,
    bills: (t?.life.bills || []).map((b) => ({ billNo: b.billNo, date: b.date, supplierInvoiceNo: b.supplierInvoiceNo, amount: b.amount, paid: b.paid, balance: b.balance, state: b.state })),
  };
}

// ── GET /summary ─────────────────────────────────────────────────────────────
router.get('/summary', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const erpPool = await getErpPool();
    await syncQuietly(pool, erpPool);
    const r = (await pool.request().input('start', sql.Date, svc.START_DATE).query(`
      SELECT Status, COUNT(*) AS n, SUM(Amount) AS amount, SUM(CASE WHEN ChangedAfterApproval = 1 THEN 1 ELSE 0 END) AS changed
      FROM dbo.GrnApprovals WHERE GrnDate >= @start GROUP BY Status`)).recordset;
    const by = Object.fromEntries(r.map((x) => [x.Status, { count: x.n, amount: Number(x.amount) || 0, changed: x.changed }]));
    res.json({ startDate: svc.START_DATE, pending: by.Pending || { count: 0, amount: 0 }, queried: by.Queried || { count: 0, amount: 0 }, approved: by.Approved || { count: 0, amount: 0 },
      needsReason: { count: await needsReasonCount(pool, erpPool) } });
  } catch (err) { next(err); }
});

// ── GET / — the Director's list ──────────────────────────────────────────────
router.get('/', authenticate, authorize(...VIEW_ROLES), async (req, res, next) => {
  try {
    const status = req.query.status || 'Pending';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const pool = await getPool();
    const erpPool = await getErpPool();
    await syncQuietly(pool, erpPool);
    // NeedsReason = open GRNs with a flagged check the GRN Reviewer has not answered yet
    const rows = await loadRows(pool, { status: status === 'NeedsReason' ? 'Open' : status, search: req.query.search, from: req.query.from, to: req.query.to });

    // Open work (Pending / Queried) is checked in full so flagged ones sort first; history is paged first.
    const openWork = ['Pending', 'Queried', 'NeedsReason'].includes(status);
    let list;
    if (openWork) {
      list = await shapeAll(pool, erpPool, rows.slice(0, 500));
      if (status === 'NeedsReason') list = list.filter((x) => x.awaitingReason > 0);
      if (req.query.flagged === '1') list = list.filter((x) => x.flagged);
      // flagged first, then oldest first — the oldest has waited longest
      list.sort((a, b) => (b.flagged - a.flagged) || (new Date(a.date) - new Date(b.date)) || (a.vchCode - b.vchCode));
      const total = list.length;
      list = list.slice((page - 1) * limit, page * limit);
      return res.json({ data: list, total, page, limit, startDate: svc.START_DATE });
    }
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    res.json({ data: await shapeAll(pool, erpPool, pageRows), total: rows.length, page, limit, startDate: svc.START_DATE });
  } catch (err) { next(err); }
});

// ── GET /accounts — what Accounts may pay ────────────────────────────────────
//   ready        approved by a Director, not billed yet in Busy
//   billed       approved and billed, not fully paid
//   paid         approved, billed and paid against the bill
//   notApproved  still with the Director or queried — don't pay (flags any already billed)
let accountsCache = null;
router.get('/accounts', authenticate, authorize(...ACCOUNTS_ROLES), async (req, res, next) => {
  try {
    const view = req.query.view || 'ready';
    const pool = await getPool();
    const erpPool = await getErpPool();
    await syncQuietly(pool, erpPool);
    const key = JSON.stringify([req.query.search || '', req.query.from || '', req.query.to || '']);
    let all;
    if (accountsCache && accountsCache.key === key && accountsCache.expires > Date.now()) all = accountsCache.rows;
    else {
      const rows = (await loadRows(pool, { status: 'All', search: req.query.search, from: req.query.from, to: req.query.to })).slice(0, 2000);
      all = await shapeAll(pool, erpPool, rows);
      accountsCache = { key, rows: all, expires: Date.now() + 60_000 };
    }
    const views = {
      ready: (x) => x.status === 'Approved' && x.billed !== 'Billed',
      billed: (x) => x.status === 'Approved' && x.billed === 'Billed' && x.paid !== 'Paid',
      paid: (x) => x.status === 'Approved' && x.paid === 'Paid',
      notApproved: (x) => x.status !== 'Approved',
    };
    if (!views[view]) return res.status(400).json({ error: 'Unknown view' });
    const counts = Object.fromEntries(Object.entries(views).map(([k, f]) => [k, all.filter(f).length]));
    const data = all.filter(views[view]).sort((a, b) => (view === 'notApproved' ? (b.billed !== 'Not billed') - (a.billed !== 'Not billed') : 0) || (new Date(a.date) - new Date(b.date)));
    res.json({
      view, counts, data, startDate: svc.START_DATE,
      totals: { amount: data.reduce((s, x) => s + x.amount, 0), balance: data.reduce((s, x) => s + x.bills.reduce((t, b) => t + (b.balance || 0), 0), 0) },
    });
  } catch (err) { next(err); }
});

// ── GET /:vchCode — one GRN, full trail ──────────────────────────────────────
router.get('/:vchCode', authenticate, authorize(...VIEW_ROLES, 'Accounts'), async (req, res, next) => {
  try {
    const vchCode = parseInt(req.params.vchCode, 10);
    if (!Number.isFinite(vchCode)) return res.status(400).json({ error: 'Invalid GRN' });
    const pool = await getPool();
    const erpPool = await getErpPool();
    await syncQuietly(pool, erpPool);
    const rows = (await pool.request().input('v', sql.Int, vchCode).query(`
      SELECT a.*, de.EntryNo, ua.FullName AS ApprovedByName, uq.FullName AS QueriedByName, ur.FullName AS ResubmittedByName
      FROM dbo.GrnApprovals a
      LEFT JOIN dbo.DeliveryEntries de ON de.EntryId = a.EntryId
      LEFT JOIN dbo.Users ua ON ua.UserId = a.ApprovedBy
      LEFT JOIN dbo.Users uq ON uq.UserId = a.QueriedBy
      LEFT JOIN dbo.Users ur ON ur.UserId = a.ResubmittedBy
      WHERE a.GrnVchCode = @v`)).recordset;
    if (!rows[0]) return res.status(404).json({ error: 'GRN not in the approval list' });
    const trail = (await svc.loadTrail(pool, erpPool, [vchCode])).get(vchCode);
    const reasons = (await svc.loadReasons(pool, [vchCode])).get(vchCode);
    const events = (await pool.request().input('v', sql.Int, vchCode).query(`
      SELECT e.Action, e.At, e.Amount, e.Notes, u.FullName AS UserName
      FROM dbo.GrnApprovalEvents e LEFT JOIN dbo.Users u ON u.UserId = e.UserId
      WHERE e.GrnVchCode = @v ORDER BY e.At, e.EventId`)).recordset;
    res.json({
      ...shape(rows[0], trail, reasons),
      lines: trail?.grn.lines || [], narration: trail?.grn.narration || null, vehicle: trail?.grn.vehicle || trail?.entry?.vehicle || null,
      entry: trail?.entry || null, events,
    });
  } catch (err) { next(err); }
});

// ── POST /approve ────────────────────────────────────────────────────────────
router.post('/approve', authenticate, authorize(...DIRECTOR_ROLES), async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
    if (!items.length) return res.status(400).json({ error: 'Choose the GRNs to approve' });
    const pool = await getPool();
    const override = req.body.override === true;
    if (override && String(req.body.note || '').trim().length < 3) {
      return res.status(400).json({ error: "Say why you are approving without the GRN Reviewer's reasons" });
    }
    const results = await svc.approveGrns(pool, await getErpPool(), { items, userId: req.user.userId, note: req.body.note, override });
    accountsCache = null; needsReasonCache = null;
    const ok = results.filter((r) => r.ok);
    if (ok.length) {
      writeAuditLog({
        entityType: 'GrnApproval', entityId: ok[0].vchCode, action: 'Update', userId: req.user.userId,
        newValues: { event: 'GRNsApproved', grns: ok.map((r) => ({ grnNo: r.grnNo, amount: r.amount, withoutReasons: r.override || undefined })), note: req.body.note || null },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
    }
    res.json({ approved: ok.length, results });
  } catch (err) { next(err); }
});

// ── POST /:vchCode/query — back to Stores ────────────────────────────────────
router.post('/:vchCode/query', authenticate, authorize(...DIRECTOR_ROLES), async (req, res, next) => {
  try {
    const vchCode = parseInt(req.params.vchCode, 10);
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Say what Stores must check or correct' });
    const pool = await getPool();
    const erpPool = await getErpPool();
    const row = await svc.queryGrn(pool, { vchCode, userId: req.user.userId, reason });
    if (!row) return res.status(409).json({ error: 'This GRN can no longer be queried — reload' });
    accountsCache = null; needsReasonCache = null;
    writeAuditLog({
      entityType: 'GrnApproval', entityId: vchCode, action: 'StatusChange', userId: req.user.userId,
      newValues: { event: 'GRNQueried', grnNo: row.GrnNo, reason }, ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    // Tell Stores (fire and forget)
    (async () => {
      const to = await svc.receiverEmails(pool, erpPool, vchCode, row.EntryId);
      const who = (await pool.request().input('u', sql.Int, req.user.userId).query('SELECT FullName FROM dbo.Users WHERE UserId = @u')).recordset[0]?.FullName;
      await sendSimpleEmail({
        to,
        subject: `GRN queried by the Director — ${row.GrnNo} | ${row.PartyName}`,
        html: `<p>${esc(who || 'A Director')} queried <strong>${esc(row.GrnNo)}</strong> (${esc(row.PartyName)}, KES ${money(row.Amount)}) before payment:</p>
               <blockquote style="border-left:3px solid #f59e0b;padding-left:8px">${esc(reason)}</blockquote>
               <p>Check or correct it in Busy, then resubmit it for approval:
               <a href="${config.appUrl}/grn-approvals?status=Queried&grn=${vchCode}">${config.appUrl}/grn-approvals</a></p>`,
      });
    })().catch((e) => logger.error(`[GrnApproval] query email failed: ${e.message}`));
    res.json({ ok: true, grnNo: row.GrnNo });
  } catch (err) { next(err); }
});

// ── POST /:vchCode/reasons — the GRN Reviewer says why each check is so ──────
router.post('/:vchCode/reasons', authenticate, authorize(...REVIEWER_ROLES), async (req, res, next) => {
  try {
    const vchCode = parseInt(req.params.vchCode, 10);
    if (!Number.isFinite(vchCode)) return res.status(400).json({ error: 'Invalid GRN' });
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
    if (!items.length) return res.status(400).json({ error: 'Give a reason for at least one check' });
    const pool = await getPool();
    const out = await svc.saveReasons(pool, await getErpPool(), { vchCode, items, userId: req.user.userId });
    accountsCache = null; needsReasonCache = null;
    writeAuditLog({
      entityType: 'GrnApproval', entityId: vchCode, action: 'Update', userId: req.user.userId,
      newValues: { event: 'GRNCheckReasons', grnNo: out.grnNo, checks: out.saved.map((s) => ({ check: s.text, reason: s.reason })) },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── POST /:vchCode/resubmit — Stores send it back to the Director ────────────
router.post('/:vchCode/resubmit', authenticate, authorize(...STORES_ROLES), async (req, res, next) => {
  try {
    const vchCode = parseInt(req.params.vchCode, 10);
    const note = String(req.body.note || '').trim();
    if (note.length < 3) return res.status(400).json({ error: 'Say what was checked or corrected' });
    const pool = await getPool();
    const row = await svc.resubmitGrn(pool, { vchCode, userId: req.user.userId, note });
    if (!row) return res.status(409).json({ error: 'Only a queried GRN can be resubmitted — reload' });
    accountsCache = null; needsReasonCache = null;
    writeAuditLog({
      entityType: 'GrnApproval', entityId: vchCode, action: 'StatusChange', userId: req.user.userId,
      newValues: { event: 'GRNResubmitted', grnNo: row.GrnNo, note }, ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ ok: true, grnNo: row.GrnNo });
  } catch (err) { next(err); }
});

router.post('/sync', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const out = await svc.syncGrnApprovals(await getPool(), await getErpPool());
    accountsCache = null;
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
