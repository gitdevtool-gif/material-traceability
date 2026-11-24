/**
 * GRN Director approval before payment (2026-11-11)
 *
 * Busy:  PO ──► GRN (Stores) ──► purchase bill (Accounts) ──► payment (Accounts)
 * Before this, a Director signed a paper copy of each GRN with the weighbridge
 * ticket attached before Accounts paid it. Now every Busy GRN (series GRN,
 * dated from GRN_APPROVAL_START) is queued here; a Director approves it on
 * screen with the whole trail in front of them — PO and its price, gate entry,
 * weighbridge ticket and weight, QA decision and rejection %, the GRN's own
 * lines — and the checks below flag what needs a closer look. A Director can
 * query a GRN back to Stores with a reason; Stores correct it in Busy and
 * resubmit. Accounts see which approved GRNs are billed / paid in Busy.
 *
 * The sync keeps each GRN's signature (amount + lines). A GRN changed in Busy
 * after it was approved goes back to Pending — an approval covers exactly what
 * the Director saw. Nothing here writes to Busy.
 */
const crypto = require('crypto');
const { sql } = require('../db');
const { sql: erpSql } = require('../erpDb');
const logger = require('../logger');
const busy = require('./busy-receiving.service');

const START_DATE = process.env.GRN_APPROVAL_START || '2026-11-11';
const INCLUSIVE_VAT_RATE = 16;         // "VAT/TaxIncl." GRNs (busy-grn.service TAX_RATES)
const TICKET_REUSE_DAYS = 30;         // weighbridge tickets repeat after a while (see weighbridge.routes)
const KG_UNITS = /^(kg|kgs|kilo|kilos|kilogram|kilograms)$/;
const TON_UNITS = /^(ton|tons|tonne|tonnes|mt)$/;
const unitKey = (u) => String(u || '').trim().toLowerCase().replace(/\./g, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function signatureOf(g) {
  const s = [round2(g.amount), ...g.lines.map((l) => `${l.itemCode}:${l.qty}:${l.price}:${round2(l.amount)}`)].join('|');
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function logEvent(req, { vchCode, action, userId = null, amount = null, notes = null }) {
  await req()
    .input('v', sql.Int, vchCode).input('a', sql.VarChar(30), action).input('u', sql.Int, userId)
    .input('amt', sql.Decimal(18, 2), amount).input('n', sql.NVarChar(1000), notes ? String(notes).slice(0, 1000) : null)
    .query('INSERT INTO dbo.GrnApprovalEvents (GrnVchCode, Action, UserId, Amount, Notes) VALUES (@v, @a, @u, @amt, @n)');
}

// ── Sync: Busy GRNs → the approval queue ─────────────────────────────────────

let lastSync = 0;
let syncing = null;

/** Queue new Busy GRNs, notice changes and deletions. Throttled: maxAgeMs = how stale is acceptable. */
async function syncGrnApprovals(pool, erpPool, { maxAgeMs = 0 } = {}) {
  if (syncing) return syncing;
  if (maxAgeMs && Date.now() - lastSync < maxAgeMs) return { skipped: true };
  syncing = (async () => {
    const grns = await busy.getGrns(erpPool, { since: new Date(`${START_DATE}T00:00:00`) });
    const existing = new Map((await pool.request().input('d', sql.Date, START_DATE)
      .query('SELECT GrnVchCode, Status, Signature, ApprovedSignature, Amount FROM dbo.GrnApprovals WHERE GrnDate >= @d'))
      .recordset.map((r) => [r.GrnVchCode, r]));
    const entryByVch = new Map();
    if (grns.length) {
      const ids = grns.map((g) => g.vchCode).join(',');
      (await pool.request().query(`SELECT EntryId, BusyGRNVchCode FROM dbo.DeliveryEntries WHERE BusyGRNVchCode IN (${ids})`))
        .recordset.forEach((r) => entryByVch.set(r.BusyGRNVchCode, r.EntryId));
    }
    const req = () => pool.request();
    let added = 0; let changed = 0; let deleted = 0;
    const seen = new Set();
    for (const g of grns) {
      seen.add(g.vchCode);
      const sig = signatureOf(g);
      const row = existing.get(g.vchCode);
      const base = req()
        .input('v', sql.Int, g.vchCode).input('no', sql.NVarChar(50), g.grnNo).input('d', sql.Date, g.date)
        .input('pc', sql.Int, g.partyCode).input('pn', sql.NVarChar(200), g.party).input('amt', sql.Decimal(18, 2), round2(g.amount))
        .input('sig', sql.VarChar(64), sig).input('e', sql.Int, entryByVch.get(g.vchCode) ?? null);
      if (!row) {
        await base.query(`INSERT INTO dbo.GrnApprovals (GrnVchCode, GrnNo, GrnDate, PartyCode, PartyName, Amount, Signature, EntryId)
                          VALUES (@v, @no, @d, @pc, @pn, @amt, @sig, @e)`);
        await logEvent(req, { vchCode: g.vchCode, action: 'Queued', amount: round2(g.amount) });
        added++;
        continue;
      }
      const wasChanged = row.Signature !== sig;
      const reopen = row.Status === 'Approved' && row.ApprovedSignature && row.ApprovedSignature !== sig;
      await base.query(`UPDATE dbo.GrnApprovals SET GrnNo = @no, GrnDate = @d, PartyCode = @pc, PartyName = @pn, Amount = @amt,
                          Signature = @sig, EntryId = COALESCE(@e, EntryId), UpdatedAt = SYSUTCDATETIME()
                          ${reopen ? ", Status = 'Pending', ChangedAfterApproval = 1" : ''}
                          ${row.Status === 'Deleted' ? ", Status = 'Pending'" : ''}
                        WHERE GrnVchCode = @v`);
      if (wasChanged) {
        changed++;
        await logEvent(req, {
          vchCode: g.vchCode, action: 'ChangedInBusy', amount: round2(g.amount),
          notes: `${reopen ? 'Changed in Busy after approval — back to the Director. ' : ''}Total ${round2(row.Amount)} → ${round2(g.amount)}`,
        });
      }
    }
    for (const [vch, row] of existing) {
      if (seen.has(vch) || row.Status === 'Deleted') continue;
      await req().input('v', sql.Int, vch).query("UPDATE dbo.GrnApprovals SET Status = 'Deleted', UpdatedAt = SYSUTCDATETIME() WHERE GrnVchCode = @v");
      await logEvent(req, { vchCode: vch, action: 'DeletedInBusy', notes: 'The GRN is no longer in Busy' });
      deleted++;
    }
    lastSync = Date.now();
    if (added || changed || deleted) logger.info(`[GrnApproval] sync: ${added} new, ${changed} changed, ${deleted} deleted in Busy`);
    return { added, changed, deleted, total: grns.length };
  })();
  try { return await syncing; } finally { syncing = null; }
}

// ── The trail and the checks ─────────────────────────────────────────────────

/**
 * For each GRN: its Busy lines with the PO price each was received against,
 * the weighbridge ticket, the gate entry with weighed kg and QA, other GRNs
 * on the same ticket, and the checks (warnings) for the Director.
 */
async function loadTrail(pool, erpPool, vchCodes) {
  const out = new Map();
  if (!vchCodes.length) return out;
  const grns = await busy.getGrns(erpPool, { vchCodes });
  const ids = vchCodes.map((v) => parseInt(v, 10)).filter(Number.isFinite).join(',');

  const [refs, other, life, taxRows] = await Promise.all([
    erpPool.request().query(`
      SELECT r.VchCode, r.ItemSrNo, ABS(r.Value1) AS Qty, LTRIM(RTRIM(o.No)) AS RefNo, LTRIM(RTRIM(pt.VchNo)) AS PONo,
             pt.[Date] AS PODate, o.Value3 AS POPrice
      FROM dbo.Tran3 r
      JOIN dbo.Tran3 o ON o.RefCode = r.RefCode AND o.Method = 1 AND o.RecType = 4
      JOIN dbo.Tran1 pt ON pt.VchCode = o.VchCode
      WHERE r.VchCode IN (${ids}) AND r.RecType = 4 AND r.Method = 2`),
    erpPool.request().query(`
      SELECT oi.VchCode, LTRIM(RTRIM(oi.OF1)) AS Ticket, t.[Date], t.MasterCode1 AS PartyCode
      FROM dbo.VchOtherInfo oi JOIN dbo.Tran1 t ON t.VchCode = oi.VchCode WHERE oi.VchCode IN (${ids})`),
    busy.getGrnLifecycle(erpPool, vchCodes),
    erpPool.request().query(`SELECT t.VchCode, LTRIM(RTRIM(st.Name)) AS TaxType FROM dbo.Tran1 t LEFT JOIN dbo.Master1 st ON st.Code = t.CM1 WHERE t.VchCode IN (${ids})`),
  ]);
  const ticketOf = new Map(other.recordset.map((r) => [r.VchCode, r]));
  // A "VAT/TaxIncl." GRN carries VAT-inclusive prices while the PO line price
  // is before VAT (94 of 99 apparent "above PO" lines in Nov 2026 were exactly
  // x1.16) — compare like with like.
  const inclRate = new Map(taxRows.recordset.map((r) => [r.VchCode, /incl/i.test(r.TaxType || '') ? INCLUSIVE_VAT_RATE : 0]));

  // Same weighbridge ticket on another GRN within 30 days.
  const tickets = [...new Set(other.recordset.map((r) => r.Ticket).filter((t) => t && /\d/.test(t)))];
  const reuse = new Map();
  if (tickets.length) {
    const rq = erpPool.request();
    tickets.forEach((t, k) => rq.input(`t${k}`, erpSql.NVarChar(60), t));
    const rows = (await rq.query(`
      SELECT oi.VchCode, LTRIM(RTRIM(oi.OF1)) AS Ticket, t.[Date], LTRIM(RTRIM(t.VchNo)) AS VchNo
      FROM dbo.VchOtherInfo oi JOIN dbo.Tran1 t ON t.VchCode = oi.VchCode
      WHERE t.VchType = 4 AND LTRIM(RTRIM(oi.OF1)) IN (${tickets.map((_, k) => `@t${k}`).join(',')})`)).recordset;
    for (const v of vchCodes) {
      const me = ticketOf.get(v);
      if (!me?.Ticket) continue;
      const dup = rows.filter((r) => r.VchCode !== v && r.Ticket === me.Ticket
        && Math.abs(new Date(r.Date) - new Date(me.Date)) <= TICKET_REUSE_DAYS * 864e5);
      if (dup.length) reuse.set(v, dup.map((d) => d.VchNo));
    }
  }

  // Gate entry, weighbridge and QA on our side.
  const entries = (await pool.request().query(`
    SELECT de.EntryId, de.EntryNo, de.BusyGRNVchCode, de.VehicleRegNo, de.DriverName, de.CreatedAt AS GateAt, de.Status,
           (SELECT SUM(ISNULL(wr.FinalNetWeight, wr.NetWeight)) FROM dbo.WeighbridgeRecords wr WHERE wr.EntryId = de.EntryId) AS NetKg,
           (SELECT TOP 1 wr.TicketNo FROM dbo.WeighbridgeRecords wr WHERE wr.EntryId = de.EntryId AND wr.TicketNo IS NOT NULL) AS TicketNo,
           qi.InspectionNo, qi.OverallStatus AS QAStatus, qi.AcceptedQty, qi.RejectedQty, uq.FullName AS QABy,
           (SELECT TOP 1 l.LogId FROM dbo.QADecisionLog l WHERE l.InspectionId = qi.InspectionId ORDER BY l.LogId DESC) AS QALogId
    FROM dbo.DeliveryEntries de
    LEFT JOIN dbo.QAInspections qi ON qi.InspectionId = (SELECT TOP 1 q2.InspectionId FROM dbo.QAInspections q2 WHERE q2.EntryId = de.EntryId ORDER BY q2.InspectionId DESC)
    LEFT JOIN dbo.Users uq ON uq.UserId = qi.ApprovedBy
    WHERE de.BusyGRNVchCode IN (${ids})`)).recordset;
  const entryOf = new Map(entries.map((e) => [e.BusyGRNVchCode, e]));

  for (const g of grns) {
    const lineRefs = refs.recordset.filter((r) => r.VchCode === g.vchCode);
    const e = entryOf.get(g.vchCode) || null;
    const rej = Number(e?.RejectedQty) || 0;
    const acc = Number(e?.AcceptedQty) || 0;
    const qaPct = rej > 0 && acc + rej > 0 ? round2((100 * rej) / (acc + rej)) : 0;
    const vat = inclRate.get(g.vchCode) || 0;
    const lines = g.lines.map((l) => {
      const rs = lineRefs.filter((r) => r.ItemSrNo === l.srNo || (r.ItemSrNo === 0 && g.lines.length === 1));
      // poPrice on the GRN's own basis (VAT-inclusive GRN → PO price + VAT)
      const poPrice = rs.length ? round2(Number(rs[0].POPrice) * (1 + vat / 100)) : null;
      return { ...l, poPrice, poPriceInclVat: vat > 0, refs: rs.map((r) => ({ poNo: r.PONo, refNo: r.RefNo, qty: Number(r.Qty), poDate: r.PODate, poPrice: Number(r.POPrice) })) };
    });

    const warnings = [];
    const add = (code, level, text) => warnings.push({ code, level, text });
    if (!lineRefs.length) add('NO_PO', 'warn', 'Received against no PO');
    for (const l of lines) {
      if (l.poPrice > 0 && l.price > l.poPrice * 1.005 + 0.001) add('PRICE_ABOVE_PO', 'high', `${l.itemName}: ${l.price} is above the PO price ${l.poPrice}`);
    }
    if (e) {
      const weighed = Number(e.NetKg) || 0;
      if (weighed > 0) {
        const kg = lines.reduce((s, l) => s + (KG_UNITS.test(unitKey(l.unitName)) ? l.qty : TON_UNITS.test(unitKey(l.unitName)) ? l.qty * 1000 : NaN), 0);
        if (Number.isFinite(kg) && kg > 0 && Math.abs(kg - weighed) > Math.max(20, weighed * 0.01)) {
          add('QTY_VS_WEIGHBRIDGE', 'warn', `GRN quantity ${round2(kg)} kg vs weighbridge net ${round2(weighed)} kg`);
        }
      }
      if (e.QAStatus === 'Rejected') add('QA_REJECTED', 'high', `QA rejected this delivery (${e.InspectionNo})`);
      else if (qaPct >= 0.5 && lines.some((l) => l.poPrice > 0 && l.price >= l.poPrice - 0.005)) {
        add('QA_REJECTION_NOT_APPLIED', 'warn', `QA rejected ${qaPct}% but the GRN is at the full PO price`);
      }
    }
    if (reuse.get(g.vchCode)) add('TICKET_REUSED', 'high', `Weighbridge ticket ${ticketOf.get(g.vchCode)?.Ticket} is also on ${reuse.get(g.vchCode).join(', ')}`);
    if (!g.approved) add('BUSY_NOT_APPROVED', 'info', 'Not yet approved in Busy by Stores');

    out.set(g.vchCode, {
      grn: { ...g, lines },
      signature: signatureOf(g),
      ticketNo: ticketOf.get(g.vchCode)?.Ticket || e?.TicketNo || null,
      entry: e && {
        entryId: e.EntryId, entryNo: e.EntryNo, vehicle: e.VehicleRegNo, driver: e.DriverName, gateAt: e.GateAt, status: e.Status,
        netKg: e.NetKg, ticketNo: e.TicketNo,
        qa: e.InspectionNo ? { inspectionNo: e.InspectionNo, decision: e.QAStatus, acceptedQty: e.AcceptedQty, rejectedQty: e.RejectedQty, rejectionPct: qaPct, by: e.QABy, logId: e.QALogId } : null,
      },
      life: life[g.vchCode] || { billed: 'Not billed', paid: null, bills: [] },
      warnings,
    });
  }
  return out;
}

// ── Reasons on the checks (2026-11-23) ───────────────────────────────────────
//
// Every flagged check (level high / warn) needs a reason from the GRN Reviewer
// before a Director approves — "why is the price above the PO", "why is the
// GRN short of the weighbridge". The reason is keyed to the check's text, so
// if the GRN changes in Busy and the difference changes, a new reason is due.

const REASON_LEVELS = new Set(['high', 'warn']);
const checkKey = (w) => `${w.code}:${crypto.createHash('sha1').update(String(w.text)).digest('hex').slice(0, 12)}`;

/**
 * All checks on a GRN as the Director sees them: loadTrail's warnings plus the
 * two that depend on the approval row. row = a GrnApprovals row.
 */
function checksFor(row, t) {
  const warnings = [...(t?.warnings || [])];
  if (row.ChangedAfterApproval) warnings.unshift({ code: 'CHANGED_AFTER_APPROVAL', level: 'high', text: 'Changed in Busy after it was approved' });
  if (t && row.Status !== 'Approved' && t.life.billed !== 'Not billed') {
    warnings.push({ code: 'BILLED_BEFORE_APPROVAL', level: 'warn', text: `${t.life.billed} in Busy before the Director approved it` });
  }
  return warnings;
}

/** vchCode → Map(checkKey → { reason, by, at }) */
async function loadReasons(pool, vchCodes) {
  const out = new Map();
  const ids = [...new Set(vchCodes.map((v) => parseInt(v, 10)).filter(Number.isFinite))];
  if (!ids.length) return out;
  const rows = (await pool.request().query(`
    SELECT r.GrnVchCode, r.CheckKey, r.Reason, r.ReasonAt, u.FullName AS ReasonByName
    FROM dbo.GrnCheckReasons r LEFT JOIN dbo.Users u ON u.UserId = r.ReasonBy
    WHERE r.GrnVchCode IN (${ids.join(',')})`)).recordset;
  for (const r of rows) {
    if (!out.has(r.GrnVchCode)) out.set(r.GrnVchCode, new Map());
    out.get(r.GrnVchCode).set(r.CheckKey, { reason: r.Reason, by: r.ReasonByName, at: r.ReasonAt });
  }
  return out;
}

/** Each check with its key, its reason (if any), and needsReason for flagged ones without. */
function withReasons(warnings, reasons) {
  return warnings.map((w) => {
    const key = checkKey(w);
    const r = reasons?.get(key) || null;
    return { ...w, key, reason: r, needsReason: REASON_LEVELS.has(w.level) && !r };
  });
}

/**
 * The GRN Reviewer's reasons: items = [{ key, reason }]. Only checks the GRN
 * has right now can be answered, and only while it waits for the Director.
 */
async function saveReasons(pool, erpPool, { vchCode, items, userId }) {
  const row = (await pool.request().input('v', sql.Int, vchCode).query('SELECT * FROM dbo.GrnApprovals WHERE GrnVchCode = @v')).recordset[0];
  if (!row) throw Object.assign(new Error('GRN not in the approval list'), { status: 404 });
  if (!['Pending', 'Queried'].includes(row.Status)) throw Object.assign(new Error(`This GRN is already ${row.Status.toLowerCase()} — reasons can no longer be changed`), { status: 409 });
  const t = (await loadTrail(pool, erpPool, [vchCode])).get(vchCode);
  if (!t) throw Object.assign(new Error('The GRN is no longer in Busy'), { status: 409 });
  const current = new Map(checksFor(row, t).filter((w) => REASON_LEVELS.has(w.level)).map((w) => [checkKey(w), w]));
  const saved = [];
  for (const it of items) {
    const w = current.get(String(it.key || ''));
    const reason = String(it.reason || '').trim();
    if (!w) throw Object.assign(new Error('That check has changed in Busy — reload and give the reason again'), { status: 409 });
    if (reason.length < 3) throw Object.assign(new Error(`Give a reason for: ${w.text}`), { status: 400 });
    await pool.request()
      .input('v', sql.Int, vchCode).input('k', sql.VarChar(80), checkKey(w)).input('c', sql.VarChar(40), w.code)
      .input('t', sql.NVarChar(500), String(w.text).slice(0, 500)).input('r', sql.NVarChar(1000), reason.slice(0, 1000)).input('u', sql.Int, userId)
      .query(`MERGE dbo.GrnCheckReasons AS x USING (SELECT @v AS GrnVchCode, @k AS CheckKey) AS s
                ON x.GrnVchCode = s.GrnVchCode AND x.CheckKey = s.CheckKey
              WHEN MATCHED THEN UPDATE SET Reason = @r, ReasonBy = @u, ReasonAt = SYSUTCDATETIME(), CheckText = @t
              WHEN NOT MATCHED THEN INSERT (GrnVchCode, CheckKey, CheckCode, CheckText, Reason, ReasonBy) VALUES (@v, @k, @c, @t, @r, @u);`);
    await logEvent(() => pool.request(), { vchCode, action: 'CheckReason', userId, amount: row.Amount, notes: `${w.text} — ${reason}` });
    saved.push({ code: w.code, text: w.text, reason });
  }
  return { grnNo: row.GrnNo, saved };
}

// ── Director / Stores actions ────────────────────────────────────────────────

/**
 * Approve GRNs exactly as the Director saw them: items = [{ vchCode, signature }].
 * A GRN changed in Busy since (different signature) is not approved.
 * A GRN with a flagged check the GRN Reviewer has not given a reason for is not
 * approved, unless override is set with a note (recorded in the history).
 */
async function approveGrns(pool, erpPool, { items, userId, note, override = false }) {
  const results = [];
  const wanted = items.map((i) => ({ vchCode: parseInt(i.vchCode, 10), signature: String(i.signature || '') })).filter((i) => Number.isFinite(i.vchCode));
  if (!wanted.length) return results;
  const noteText = note ? String(note).trim() : '';
  const vchs = wanted.map((w) => w.vchCode);
  const [trail, reasons] = await Promise.all([loadTrail(pool, erpPool, vchs), loadReasons(pool, vchs)]);
  for (const w of wanted) {
    const t = trail.get(w.vchCode);
    const row = (await pool.request().input('v', sql.Int, w.vchCode).query('SELECT GrnNo, Status, ChangedAfterApproval FROM dbo.GrnApprovals WHERE GrnVchCode = @v')).recordset[0];
    if (!row) { results.push({ vchCode: w.vchCode, ok: false, error: 'Not in the approval list — reload' }); continue; }
    if (!t) { results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: false, error: 'No longer in Busy' }); continue; }
    if (!['Pending', 'Queried'].includes(row.Status)) { results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: false, error: `Already ${row.Status.toLowerCase()}` }); continue; }
    const g = t.grn;
    const sig = t.signature;
    if (sig !== w.signature) { results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: false, error: 'Changed in Busy since you opened it — reload and check it again' }); continue; }
    const missing = withReasons(checksFor(row, t), reasons.get(w.vchCode)).filter((c) => c.needsReason);
    if (missing.length && !(override && noteText.length >= 3)) {
      results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: false, needsReason: missing.length, error: `Waiting for the GRN Reviewer's reason on ${missing.length} check${missing.length === 1 ? '' : 's'}` });
      continue;
    }
    const upd = await pool.request()
      .input('v', sql.Int, w.vchCode).input('u', sql.Int, userId).input('amt', sql.Decimal(18, 2), round2(g.amount))
      .input('sig', sql.VarChar(64), sig).input('n', sql.NVarChar(500), noteText ? noteText.slice(0, 500) : null)
      .query(`UPDATE dbo.GrnApprovals SET Status = 'Approved', ApprovedBy = @u, ApprovedAt = SYSUTCDATETIME(), ApprovedAmount = @amt,
                ApprovedSignature = @sig, ApprovalNote = @n, ChangedAfterApproval = 0, Amount = @amt, Signature = @sig, UpdatedAt = SYSUTCDATETIME()
              WHERE GrnVchCode = @v AND Status IN ('Pending', 'Queried')`);
    if (!upd.rowsAffected[0]) { results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: false, error: 'Changed by someone else — reload' }); continue; }
    const overrideText = missing.length ? `Approved without the reviewer's reason on: ${missing.map((m) => m.text).join('; ')}. ` : '';
    await logEvent(() => pool.request(), { vchCode: w.vchCode, action: missing.length ? 'ApprovedOverride' : 'Approved', userId, amount: round2(g.amount), notes: `${overrideText}${noteText}` || null });
    results.push({ vchCode: w.vchCode, grnNo: row.GrnNo, ok: true, amount: round2(g.amount), override: missing.length > 0 });
  }
  return results;
}

async function queryGrn(pool, { vchCode, userId, reason }) {
  const upd = await pool.request()
    .input('v', sql.Int, vchCode).input('u', sql.Int, userId).input('r', sql.NVarChar(1000), String(reason).slice(0, 1000))
    .query(`UPDATE dbo.GrnApprovals SET Status = 'Queried', QueriedBy = @u, QueriedAt = SYSUTCDATETIME(), QueryReason = @r, UpdatedAt = SYSUTCDATETIME()
            OUTPUT INSERTED.GrnNo, INSERTED.PartyName, INSERTED.Amount, INSERTED.EntryId
            WHERE GrnVchCode = @v AND Status IN ('Pending', 'Approved')`);
  const row = upd.recordset[0];
  if (row) await logEvent(() => pool.request(), { vchCode, action: 'Queried', userId, amount: row.Amount, notes: reason });
  return row || null;
}

async function resubmitGrn(pool, { vchCode, userId, note }) {
  const upd = await pool.request()
    .input('v', sql.Int, vchCode).input('u', sql.Int, userId).input('n', sql.NVarChar(1000), String(note).slice(0, 1000))
    .query(`UPDATE dbo.GrnApprovals SET Status = 'Pending', ResubmittedBy = @u, ResubmittedAt = SYSUTCDATETIME(), ResubmitNote = @n, UpdatedAt = SYSUTCDATETIME()
            OUTPUT INSERTED.GrnNo, INSERTED.Amount
            WHERE GrnVchCode = @v AND Status = 'Queried'`);
  const row = upd.recordset[0];
  if (row) await logEvent(() => pool.request(), { vchCode, action: 'Resubmitted', userId, amount: row.Amount, notes: note });
  return row || null;
}

/**
 * Who to tell about a query: the user who received it here (Receive in Busy),
 * else the Busy user who entered the GRN (matched by linked Busy login), else
 * every active Stores user.
 */
async function receiverEmails(pool, erpPool, vchCode, entryId) {
  if (entryId) {
    const r = (await pool.request().input('e', sql.VarChar(20), String(entryId)).query(`
      SELECT TOP 1 u.Email FROM dbo.AuditLogs a JOIN dbo.Users u ON u.UserId = a.UserId
      WHERE a.EntityType = 'DeliveryEntry' AND a.EntityId = @e AND a.NewValues LIKE '%"event":"ReceivedInBusy"%' AND u.IsActive = 1 AND u.Email LIKE '%@%'
      ORDER BY a.Timestamp DESC`)).recordset[0];
    if (r) return [r.Email];
  }
  const busyUser = (await erpPool.request().input('v', erpSql.Int, vchCode)
    .query("SELECT TOP 1 LTRIM(RTRIM(UserName)) AS U FROM dbo.CheckList WHERE Type = 2 AND Code = @v AND Action = 1 AND UserName <> 'Supervisor' ORDER BY ActionTime"))
    .recordset[0]?.U;
  if (busyUser) {
    const r = (await pool.request().input('b', sql.NVarChar(100), busyUser)
      .query("SELECT Email FROM dbo.Users WHERE IsActive = 1 AND UPPER(BusyUserName) = UPPER(@b) AND Email LIKE '%@%'")).recordset;
    if (r.length) return r.map((x) => x.Email);
  }
  return (await pool.request().query("SELECT Email FROM dbo.Users WHERE IsActive = 1 AND Role = 'StoreReceiving' AND Email LIKE '%@%'"))
    .recordset.map((x) => x.Email);
}

// ── Background job: sync + the Directors' morning email ──────────────────────

const JOB_INTERVAL_MS = parseInt(process.env.GRN_APPROVAL_SYNC_MS, 10) || 10 * 60_000;
const DIGEST_HOUR = Number.isFinite(parseInt(process.env.GRN_DIGEST_HOUR, 10)) ? parseInt(process.env.GRN_DIGEST_HOUR, 10) : 8;
const DIGEST_KEY = 'grnApproval.lastDigest';   // AppSettings row, not shown on the Settings page
const REVIEWER_DIGEST_HOUR = Number.isFinite(parseInt(process.env.GRN_REVIEWER_DIGEST_HOUR, 10)) ? parseInt(process.env.GRN_REVIEWER_DIGEST_HOUR, 10) : Math.max(0, DIGEST_HOUR - 1);
const REVIEWER_DIGEST_KEY = 'grnApproval.lastReviewerDigest';
let jobTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Once a day from DIGEST_HOUR: what is waiting for the Directors, flagged ones listed. */
async function sendDirectorDigest(pool, erpPool, { force = false } = {}) {
  const today = localDay();
  if (!force) {
    if (new Date().getHours() < DIGEST_HOUR) return { skipped: 'too early' };
    const last = (await pool.request().input('k', sql.VarChar(100), DIGEST_KEY).query('SELECT SettingValue FROM dbo.AppSettings WHERE SettingKey = @k')).recordset[0];
    if (last && JSON.parse(last.SettingValue) === today) return { skipped: 'already sent today' };
  }
  const pending = (await pool.request().input('d', sql.Date, START_DATE)
    .query("SELECT GrnVchCode, GrnNo, GrnDate, PartyName, Amount, ResubmittedAt, ChangedAfterApproval FROM dbo.GrnApprovals WHERE Status = 'Pending' AND GrnDate >= @d ORDER BY GrnDate"))
    .recordset;
  const markSent = () => pool.request().input('k', sql.VarChar(100), DIGEST_KEY).input('v', sql.NVarChar(sql.MAX), JSON.stringify(today))
    .query(`MERGE dbo.AppSettings AS t USING (SELECT @k AS SettingKey) AS s ON t.SettingKey = s.SettingKey
            WHEN MATCHED THEN UPDATE SET SettingValue = @v, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@k, @v);`);
  if (!pending.length) { await markSent(); return { sent: false, pending: 0 }; }

  const checks = await pendingChecks(pool, erpPool, pending);
  const flagged = pending.filter((p) => checks.get(p.GrnVchCode).some((w) => REASON_LEVELS.has(w.level)));
  const waiting = flagged.filter((p) => checks.get(p.GrnVchCode).some((w) => w.needsReason));
  const to = (await pool.request().query("SELECT Email FROM dbo.Users WHERE IsActive = 1 AND Role = 'Director' AND Email LIKE '%@%'")).recordset.map((r) => r.Email);
  const config = require('../config');
  const { sendSimpleEmail } = require('./email.service');
  const total = pending.reduce((s, p) => s + Number(p.Amount), 0);
  const rows = flagged.slice(0, 25).map((p) => {
    const w = checks.get(p.GrnVchCode).filter((x) => REASON_LEVELS.has(x.level))
      .map((x) => `<span style="color:#b45309">${esc(x.text)}</span>${x.reason ? `<br><span style="color:#065f46">Reason: ${esc(x.reason.reason)} (${esc(x.reason.by || 'reviewer')})</span>` : '<br><em style="color:#991b1b">awaiting the GRN Reviewer\'s reason</em>'}`);
    return `<tr><td style="padding:4px 8px">${esc(p.GrnNo)}</td><td style="padding:4px 8px">${esc(p.PartyName)}</td>
            <td style="padding:4px 8px;text-align:right">${money(p.Amount)}</td><td style="padding:4px 8px">${w.join('<br>')}</td></tr>`;
  }).join('');
  const ok = await sendSimpleEmail({
    to,
    subject: `${pending.length} GRN${pending.length === 1 ? '' : 's'} waiting for your approval — KES ${money(total)}`,
    html: `<p>${pending.length} GRN${pending.length === 1 ? ' is' : 's are'} waiting for a Director's approval before Accounts pay
           (KES ${money(total)}${pending.some((p) => p.ResubmittedAt) ? `; ${pending.filter((p) => p.ResubmittedAt).length} resubmitted by Stores after a query` : ''}).</p>
           ${flagged.length ? `<p><strong>${flagged.length} need a closer look</strong>${waiting.length ? ` — ${waiting.length} still waiting for the GRN Reviewer's reason before you can approve` : ' — the GRN Reviewer has given a reason on every check'}:</p>
           <table style="border-collapse:collapse;font-size:13px" border="1"><tr><th>GRN</th><th>Supplier</th><th>KES</th><th>Check and reason</th></tr>${rows}</table>` : '<p>None is flagged.</p>'}
           <p><a href="${config.appUrl}/grn-approvals">Open GRN Approval</a></p>`,
  });
  if (ok) await markSent();
  return { sent: ok, pending: pending.length, flagged: flagged.length, waitingForReason: waiting.length };
}

/** For pending GRN rows: vchCode → checks with reasons. */
async function pendingChecks(pool, erpPool, rows) {
  const vchs = rows.slice(0, 300).map((p) => p.GrnVchCode);
  const [trail, reasons] = await Promise.all([loadTrail(pool, erpPool, vchs), loadReasons(pool, vchs)]);
  return new Map(rows.map((p) => [p.GrnVchCode, withReasons(checksFor({ ...p, Status: 'Pending' }, trail.get(p.GrnVchCode)), reasons.get(p.GrnVchCode))]));
}

/**
 * Once a day from REVIEWER_DIGEST_HOUR (an hour before the Directors' email by
 * default): the GRNs whose flagged checks still need the GRN Reviewer's reason.
 */
async function sendReviewerDigest(pool, erpPool, { force = false } = {}) {
  const today = localDay();
  if (!force) {
    if (new Date().getHours() < REVIEWER_DIGEST_HOUR) return { skipped: 'too early' };
    const last = (await pool.request().input('k', sql.VarChar(100), REVIEWER_DIGEST_KEY).query('SELECT SettingValue FROM dbo.AppSettings WHERE SettingKey = @k')).recordset[0];
    if (last && JSON.parse(last.SettingValue) === today) return { skipped: 'already sent today' };
  }
  const markSent = () => pool.request().input('k', sql.VarChar(100), REVIEWER_DIGEST_KEY).input('v', sql.NVarChar(sql.MAX), JSON.stringify(today))
    .query(`MERGE dbo.AppSettings AS t USING (SELECT @k AS SettingKey) AS s ON t.SettingKey = s.SettingKey
            WHEN MATCHED THEN UPDATE SET SettingValue = @v, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@k, @v);`);
  const to = (await pool.request().query("SELECT Email FROM dbo.Users WHERE IsActive = 1 AND Role = 'GrnReviewer' AND Email LIKE '%@%'")).recordset.map((r) => r.Email);
  if (!to.length) { await markSent(); return { sent: false, reason: 'no GRN Reviewer with an email' }; }
  const open = (await pool.request().input('d', sql.Date, START_DATE)
    .query("SELECT GrnVchCode, GrnNo, GrnDate, PartyName, Amount, Status, ChangedAfterApproval FROM dbo.GrnApprovals WHERE Status IN ('Pending', 'Queried') AND GrnDate >= @d ORDER BY GrnDate"))
    .recordset;
  const checks = await pendingChecks(pool, erpPool, open);
  const todo = open.filter((p) => checks.get(p.GrnVchCode).some((w) => w.needsReason));
  if (!todo.length) { await markSent(); return { sent: false, waiting: 0 }; }
  const config = require('../config');
  const { sendSimpleEmail } = require('./email.service');
  const rows = todo.slice(0, 40).map((p) => `<tr><td style="padding:4px 8px">${esc(p.GrnNo)}</td><td style="padding:4px 8px">${esc(p.PartyName)}</td>
      <td style="padding:4px 8px;text-align:right">${money(p.Amount)}</td>
      <td style="padding:4px 8px;color:#b45309">${checks.get(p.GrnVchCode).filter((w) => w.needsReason).map((w) => esc(w.text)).join('<br>')}</td></tr>`).join('');
  const ok = await sendSimpleEmail({
    to,
    subject: `${todo.length} GRN${todo.length === 1 ? '' : 's'} need a reason on the checks before the Director can approve`,
    html: `<p>The Director cannot approve these GRNs until you say why each flagged check is so:</p>
           <table style="border-collapse:collapse;font-size:13px" border="1"><tr><th>GRN</th><th>Supplier</th><th>KES</th><th>Check</th></tr>${rows}</table>
           ${todo.length > 40 ? `<p>…and ${todo.length - 40} more.</p>` : ''}
           <p><a href="${config.appUrl}/grn-approvals?status=NeedsReason">Open GRN Approval — Awaiting reason</a></p>`,
  });
  if (ok) await markSent();
  return { sent: ok, waiting: todo.length };
}

function startGrnApprovalJob() {
  if (jobTimer) return;
  const { getPool } = require('../db');
  const { getErpPool } = require('../erpDb');
  const run = async () => {
    try {
      const [pool, erpPool] = await Promise.all([getPool(), getErpPool()]);
      // First close trucks that Stores received straight in Busy, so the
      // approval rows below pick up their weighbridge/QA trail (EntryId).
      if (process.env.GRN_AUTO_LINK !== 'false') {
        const link = require('./entry-grn-link.service');
        try {
          const { fixed } = await link.backfillGrnNumberLinks(pool, erpPool);
          const { linked, failed } = await link.autoLinkTicketMatches(pool, erpPool);
          if (fixed.length || linked.length || failed.length) {
            logger.info(`[GrnAutoLink] ${linked.length} entr${linked.length === 1 ? 'y' : 'ies'} linked to Busy GRNs by ticket, ${fixed.length} GRN-screen link(s) filled, ${failed.length} failed`
              + (linked.length ? `: ${linked.map((l) => `${l.entryNo}→${l.grnNo}`).join(', ')}` : '')
              + (failed.length ? ` | failed: ${failed.map((f) => `${f.entryNo}: ${f.error}`).join('; ')}` : ''));
          }
        } catch (err) {
          logger.error(`[GrnAutoLink] error (non-fatal): ${err.message}`);
        }
      }
      // GRNs pushed from here without Busy's pending-challan refs can't be
      // billed by Accounts (2026-11-17). Writes to Busy, so only when switched on.
      if (process.env.GRN_CHALLAN_REPAIR === 'true') {
        const g = require('./busy-grn.service');
        try {
          const todo = (await g.grnsMissingChallans(erpPool)).slice(0, 20);
          const done = []; const bad = [];
          for (const x of todo) {
            const r = await g.addChallanRefs(erpPool, x.VchCode);
            (r.ok ? done : bad).push(r.ok ? x.VchNo : `${x.VchNo}: ${r.error}`);
          }
          if (todo.length) logger.info(`[GrnChallanRepair] ${done.length} GRN(s) made billable: ${done.join(', ')}${bad.length ? ` | failed: ${bad.join('; ')}` : ''}`);
        } catch (err) {
          logger.error(`[GrnChallanRepair] error (non-fatal): ${err.message}`);
        }
      }
      await syncGrnApprovals(pool, erpPool);
      try { await sendReviewerDigest(pool, erpPool); } catch (err) { logger.error(`[GrnApproval] reviewer email error (non-fatal): ${err.message}`); }
      await sendDirectorDigest(pool, erpPool);
    } catch (err) {
      logger.error(`[GrnApproval] job error (non-fatal): ${err.message}`);
    }
  };
  logger.info(`[GrnApproval] job started — every ${JOB_INTERVAL_MS / 60000} min, Director email from ${DIGEST_HOUR}:00`);
  setTimeout(run, 30_000);
  jobTimer = setInterval(run, JOB_INTERVAL_MS);
}
function stopGrnApprovalJob() { if (jobTimer) clearInterval(jobTimer); jobTimer = null; }

module.exports = {
  START_DATE, signatureOf, syncGrnApprovals, loadTrail, approveGrns, queryGrn, resubmitGrn, receiverEmails,
  checksFor, checkKey, loadReasons, withReasons, saveReasons,
  sendDirectorDigest, sendReviewerDigest, startGrnApprovalJob, stopGrnApprovalJob,
};
