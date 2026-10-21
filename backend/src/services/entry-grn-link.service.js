/**
 * Gate entry ↔ Busy GRN linking (2026-10-17)
 *
 * Phase 0 clean-up for deliveries that were logged at the gate here but
 * received (GRN'd) in Busy by hand. Suggests which Busy GRN each open gate
 * entry became, and links one when a person confirms it (or in bulk for
 * high-confidence matches only).
 *
 * Evidence, strongest first (all verified in live data):
 *   ticket   Busy GRN narration carries our weighbridge ticket
 *            ("Ticket No.9639") on farm-produce deliveries
 *   vehicle  Busy GRN "Transport" = vehicle reg (99% of GRNs; "." on farm GRNs)
 *   items    same Busy item on both
 *   date     Busy GRN dated 0–7 days after the gate (observed lag)
 * Only GRNs of the entry's own Busy party are ever considered.
 *
 * Linking reuses this system's own GRN record: a GoodsReceiptNotes row whose
 * GRNNo is the Busy GRN number (as the GRN screen already allows via
 * erpVchNo). Its UQ_GRN_GRNNo / UQ_GRN_EntryId constraints are what make a
 * Busy GRN linkable to one entry only.
 */
const { sql } = require('../db');
const { writeAuditLog, writeStatusHistory } = require('./audit.service');
const { getGrns, ensureMaterialForBusyItem } = require('./busy-receiving.service');

// Entries still somewhere in the gate → GRN pipeline.
const CLOSED_STATUSES = ['GRNCreated', 'Cancelled', 'Rejected', 'Closed'];

const normVehicle = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const ticketsIn = (text) => [...String(text || '').matchAll(/ticket\s*no\.?\s*(\d{3,})/gi)].map((m) => m[1]);
const dayDiff = (a, b) => Math.round((new Date(new Date(a).toDateString()) - new Date(new Date(b).toDateString())) / 864e5);
const busyPartyCode = (supplierCode) => {
  const s = String(supplierCode || '').trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
};

// add-busy-receiving-link.sql adds the Busy link columns. Until it has run,
// reads fall back to NULLs and linking is refused with a clear message.
let migrationApplied = null;
async function hasLinkColumns(pool) {
  if (migrationApplied) return true;
  const r = await pool.request().query(`
    SELECT CASE WHEN COL_LENGTH('dbo.DeliveryEntries', 'BusyGRNVchCode') IS NOT NULL
                 AND COL_LENGTH('dbo.DeliveryEntryItems', 'BusyItemCode') IS NOT NULL
                 AND COL_LENGTH('dbo.Materials', 'BusyItemCode') IS NOT NULL
                 AND COL_LENGTH('dbo.Suppliers', 'MergedIntoSupplierId') IS NOT NULL THEN 1 ELSE 0 END AS ok`);
  migrationApplied = r.recordset[0].ok === 1 ? true : null;
  return !!migrationApplied;
}
const MIGRATION_MISSING = 'Database update add-busy-receiving-link.sql has not been run yet.';

/** Open gate entries with what's needed to match them. */
async function loadOpenEntries(pool, { entryIds } = {}) {
  const linkCols = await hasLinkColumns(pool);
  const req = pool.request();
  let where = `de.Status NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`;
  if (entryIds) {
    if (entryIds.length === 0) return [];
    entryIds.forEach((id, i) => req.input(`e${i}`, sql.Int, id));
    where += ` AND de.EntryId IN (${entryIds.map((_, i) => `@e${i}`).join(',')})`;
  }
  const entries = (await req.query(`
    SELECT de.EntryId, de.EntryNo, de.Status, de.DeliveryDate, de.CreatedAt, de.VehicleRegNo, de.Destination,
           de.PurchaseOrderNo, s.SupplierId, s.SupplierCode, s.SupplierName,
           wr.TicketNo, wr.NetWeight
    FROM dbo.DeliveryEntries de
    JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
    LEFT JOIN dbo.WeighbridgeRecords wr ON wr.EntryId = de.EntryId
    WHERE ${where}
    ORDER BY de.DeliveryDate DESC, de.EntryId DESC`)).recordset;
  if (entries.length === 0) return [];

  const itemsReq = pool.request();
  entries.forEach((e, i) => itemsReq.input(`i${i}`, sql.Int, e.EntryId));
  const items = (await itemsReq.query(`
    SELECT dei.EntryId, dei.Quantity, m.MaterialName,
           ${linkCols ? 'dei.BusyItemCode, dei.BusyPONo, m.BusyItemCode AS MaterialBusyItemCode' : 'NULL AS BusyItemCode, NULL AS BusyPONo, NULL AS MaterialBusyItemCode'}
    FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
    WHERE dei.EntryId IN (${entries.map((_, i) => `@i${i}`).join(',')})`)).recordset;
  const itemsByEntry = {};
  for (const it of items) (itemsByEntry[it.EntryId] ||= []).push(it);

  return entries.map((e) => ({
    ...e,
    partyCode: busyPartyCode(e.SupplierCode),
    items: itemsByEntry[e.EntryId] || [],
  }));
}

/**
 * Busy GRNs already linked to an entry here: VchCode / GRN number → the
 * entry numbers on it (several when one Busy GRN covers several trucks).
 */
async function loadLinkedGrns(pool) {
  const linkCols = await hasLinkColumns(pool);
  const result = await pool.request().query(`
    ${linkCols ? `SELECT de.BusyGRNVchCode AS VchCode, NULL AS GRNNo, de.EntryNo FROM dbo.DeliveryEntries de
                  WHERE de.BusyGRNVchCode IS NOT NULL UNION ALL` : ''}
    SELECT NULL AS VchCode, LTRIM(RTRIM(g.GRNNo)) AS GRNNo, de.EntryNo
    FROM dbo.GoodsReceiptNotes g JOIN dbo.DeliveryEntries de ON de.EntryId = g.EntryId
    WHERE g.GRNStatus <> 'Reversed'`);
  const byVch = new Map();
  const byNo = new Map();
  for (const r of result.recordset) {
    if (r.VchCode) (byVch.get(r.VchCode) || byVch.set(r.VchCode, new Set()).get(r.VchCode)).add(r.EntryNo);
    if (r.GRNNo) (byNo.get(r.GRNNo) || byNo.set(r.GRNNo, new Set()).get(r.GRNNo)).add(r.EntryNo);
  }
  const entriesOn = (grn) => [...new Set([...(byVch.get(grn.vchCode) || []), ...(byNo.get(grn.grnNo) || [])])];
  return { entriesOn };
}

function scoreGrn(entry, grn) {
  const reasons = [];
  let score = 0;
  const lag = dayDiff(grn.date, entry.DeliveryDate || entry.CreatedAt);
  if (lag < -1 || lag > 10) return null;

  const ticketMatch = entry.TicketNo && ticketsIn(grn.narration).includes(String(entry.TicketNo).replace(/\D/g, ''));
  if (ticketMatch) { score += 100; reasons.push(`weighbridge ticket ${entry.TicketNo} in Busy narration`); }

  const vehicleMatch = grn.vehicle && normVehicle(grn.vehicle) === normVehicle(entry.VehicleRegNo) && normVehicle(grn.vehicle).length >= 4;
  if (vehicleMatch) { score += 60; reasons.push(`same vehicle ${grn.vehicle}`); }

  const entryItemCodes = new Set(entry.items.map((i) => i.BusyItemCode || i.MaterialBusyItemCode).filter(Boolean));
  const entryItemNames = new Set(entry.items.map((i) => normName(i.MaterialName)));
  const itemHits = grn.lines.filter((l) => entryItemCodes.has(l.itemCode) || entryItemNames.has(normName(l.itemName)));
  if (itemHits.length) { score += 30; reasons.push(`same item (${itemHits[0].itemName})`); }

  const entryPos = new Set(entry.items.map((i) => i.BusyPONo).filter(Boolean));
  if (grn.poNos.some((p) => entryPos.has(p))) { score += 40; reasons.push('same PO'); }

  score += lag === 0 ? 20 : lag === 1 ? 15 : lag === 2 ? 10 : lag <= 5 ? 5 : 0;
  reasons.push(lag === 0 ? 'same day' : `${lag} day(s) ${lag < 0 ? 'before' : 'after'} the gate`);
  return { score, lag, ticketMatch: !!ticketMatch, vehicleMatch: !!vehicleMatch, reasons };
}

/**
 * Suggestions per open entry: Busy GRNs of the same party, scored.
 * confidence 'High' only when the evidence is unambiguous.
 */
async function suggestLinks(pool, erpPool, { entryIds } = {}) {
  const entries = await loadOpenEntries(pool, { entryIds });
  const withParty = entries.filter((e) => e.partyCode);
  const result = new Map(entries.map((e) => [e.EntryId, { entry: e, suggestions: [] }]));
  if (withParty.length === 0) return [...result.values()];

  const dates = withParty.map((e) => new Date(e.DeliveryDate || e.CreatedAt).getTime());
  const since = new Date(Math.min(...dates) - 2 * 864e5);
  const linked = await loadLinkedGrns(pool);
  const grns = await getGrns(erpPool, { since });
  const grnsByParty = {};
  for (const g of grns) (grnsByParty[g.partyCode] ||= []).push(g);

  for (const e of withParty) {
    const scored = (grnsByParty[e.partyCode] || [])
      .map((g) => ({ grn: g, alreadyLinkedTo: linked.entriesOn(g), ...scoreGrn(e, g) }))
      .filter((s) => s.score !== undefined && s.score !== null && s.reasons)
      // A GRN already linked to another entry is still offered (Busy sometimes
      // puts several trucks on one GRN) but ranked below unlinked ones.
      .map((s) => (s.alreadyLinkedTo.length ? { ...s, score: s.score - 25, reasons: [...s.reasons, `already linked to ${s.alreadyLinkedTo.join(', ')}`] } : s))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    scored.forEach((s, i) => {
      const next = scored[i + 1];
      const decisive = !next || s.score - next.score >= 30;
      s.confidence = i === 0 && decisive && !s.alreadyLinkedTo.length && (s.ticketMatch || (s.vehicleMatch && s.lag >= 0 && s.lag <= 3))
        ? 'High' : s.score >= 50 ? 'Medium' : 'Low';
    });
    result.get(e.EntryId).suggestions = scored.map((s) => ({
      grnVchCode: s.grn.vchCode, grnNo: s.grn.grnNo, date: s.grn.date, party: s.grn.party,
      vehicle: s.grn.vehicle, narration: s.grn.narration, amount: s.grn.amount, poNos: s.grn.poNos,
      lines: s.grn.lines, score: s.score, confidence: s.confidence, reasons: s.reasons,
      alreadyLinkedTo: s.alreadyLinkedTo,
    }));
  }

  // A GRN can only become one entry: when two entries' top "High" pick is
  // the same GRN, neither is auto-linkable.
  const highByGrn = {};
  for (const r of result.values()) {
    const top = r.suggestions[0];
    if (top?.confidence === 'High') (highByGrn[top.grnVchCode] ||= []).push(r);
  }
  for (const list of Object.values(highByGrn)) {
    if (list.length > 1) list.forEach((r) => { r.suggestions[0].confidence = 'Medium'; });
  }
  return [...result.values()];
}

/**
 * Link one open entry to one Busy GRN. Creates the entry's GRN record here
 * (GRNNo = Busy number, batch = Busy GRN number, which is Busy's own batch
 * number for the receipt) with lines copied from Busy, and closes the entry
 * as GRNCreated.
 */
async function linkEntryToGrn(pool, erpPool, {
  entryId, grnVchCode, userId, method, allowPartyMismatch = false, allowShared = false, ipAddress, userAgent,
}) {
  if (!(await hasLinkColumns(pool))) return { ok: false, status: 503, error: MIGRATION_MISSING };
  const [entry] = await loadOpenEntries(pool, { entryIds: [entryId] });
  if (!entry) return { ok: false, status: 409, error: 'Entry not found or already closed / received' };

  const [grn] = await getGrns(erpPool, { vchCodes: [grnVchCode] });
  if (!grn) return { ok: false, status: 404, error: 'Busy GRN not found' };

  if (entry.partyCode !== grn.partyCode && !allowPartyMismatch) {
    return {
      ok: false, status: 409, code: 'PARTY_MISMATCH',
      error: `Busy GRN ${grn.grnNo} is for "${grn.party}", but this gate entry is for "${entry.SupplierName}".`,
    };
  }

  // One Busy GRN ↔ one entry, unless a person confirms Busy put several
  // trucks on this GRN. Never automatic.
  const sharedWith = (await loadLinkedGrns(pool)).entriesOn(grn);
  if (sharedWith.length && (!allowShared || method !== 'Manual')) {
    return {
      ok: false, status: 409, code: 'GRN_ALREADY_LINKED', linkedTo: sharedWith,
      error: `Busy GRN ${grn.grnNo} is already linked to ${sharedWith.join(', ')}`,
    };
  }
  // Our GRN record needs a unique number: the 2nd/3rd truck on one Busy GRN
  // gets "Njr-1701---2026-27 (2)"; the batch stays the Busy GRN number.
  const ourGrnNo = sharedWith.length ? `${grn.grnNo} (${sharedWith.length + 1})` : grn.grnNo;

  const receivingDept = entry.Destination === 'CentralStore' ? 'CentralStore' : 'Factory';
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const request = () => new sql.Request(tx);
    const grnRow = (await request()
      .input('grnNo', sql.VarChar(50), ourGrnNo)
      .input('batchNo', sql.VarChar(30), grn.grnNo.slice(0, 30))
      .input('entryId', sql.Int, entry.EntryId)
      .input('dept', sql.VarChar(30), receivingDept)
      .input('receivedBy', sql.Int, userId)
      .input('receivedAt', sql.DateTime2, grn.date)
      .input('notes', sql.NVarChar(500), sharedWith.length
        ? `Linked to Busy GRN ${grn.grnNo} (${method}), which also covers ${sharedWith.join(', ')} — quantities are on that Busy GRN.`
        : `Linked to Busy GRN ${grn.grnNo} (${method}).`)
      .query(`INSERT INTO dbo.GoodsReceiptNotes (GRNNo, BatchNo, EntryId, ReceivingDept, GRNStatus, ReceivedBy, ReceivedAt, Notes)
              OUTPUT INSERTED.GRNId
              VALUES (@grnNo, @batchNo, @entryId, @dept, 'Created', @receivedBy, @receivedAt, @notes)`)).recordset[0];

    // A shared Busy GRN's lines can't be split per truck — they stay on the
    // first entry's record only, so totals are never double-counted.
    for (const line of sharedWith.length ? [] : grn.lines) {
      const material = await ensureMaterialForBusyItem(request, line);
      await request()
        .input('grnId', sql.Int, grnRow.GRNId)
        .input('materialId', sql.Int, material.MaterialId)
        .input('qty', sql.Decimal(12, 2), line.qty)
        .input('uom', sql.VarChar(20), String(line.unitName || material.UOM || 'Units').slice(0, 20))
        .input('remarks', sql.NVarChar(500), `From Busy ${grn.grnNo} line ${line.srNo}${line.store ? ` · ${line.store}` : ''}`)
        .query(`INSERT INTO dbo.GRNItems (GRNId, MaterialId, ExpectedQty, ReceivedQty, AcceptedQty, RejectedQty, UOM, Remarks)
                VALUES (@grnId, @materialId, @qty, @qty, @qty, 0, @uom, @remarks)`);
    }

    await request()
      .input('entryId', sql.Int, entry.EntryId)
      .input('vchCode', sql.Int, grn.vchCode)
      .input('grnNo', sql.NVarChar(40), grn.grnNo)
      .input('userId', sql.Int, userId)
      .input('method', sql.VarChar(20), method)
      .input('poNo', sql.VarChar(30), grn.poNos.join(', ').slice(0, 30) || null)
      .query(`UPDATE dbo.DeliveryEntries
              SET Status = 'GRNCreated', BusyGRNVchCode = @vchCode, BusyGRNNo = @grnNo,
                  BusyGRNLinkedAt = GETUTCDATE(), BusyGRNLinkedBy = @userId, BusyGRNLinkMethod = @method,
                  PurchaseOrderNo = COALESCE(NULLIF(PurchaseOrderNo, ''), @poNo),
                  VersionNo = VersionNo + 1, UpdatedAt = GETUTCDATE()
              WHERE EntryId = @entryId`);
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    if (err.number === 2627 || err.number === 2601) {
      return { ok: false, status: 409, error: 'This entry or Busy GRN was linked by someone else just now' };
    }
    throw err;
  }

  writeAuditLog({
    entityType: 'DeliveryEntry', entityId: entry.EntryId, action: 'LinkBusyGRN', userId,
    oldValues: { status: entry.Status }, newValues: { busyGrnNo: grn.grnNo, busyGrnVchCode: grn.vchCode, method },
    ipAddress, userAgent,
  });
  writeStatusHistory({
    entityType: 'DeliveryEntry', entityId: entry.EntryId, fromStatus: entry.Status, toStatus: 'GRNCreated',
    changedBy: userId, remarks: `Received in Busy as ${grn.grnNo} (${method})`,
  });
  return { ok: true, entryNo: entry.EntryNo, grnNo: grn.grnNo, sharedWith };
}

// ── Supplier clean-up ───────────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
const tokenSim = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);
const NOISE = new Set(['LTD', 'LIMITED', 'CO', 'COMPANY', 'THE', 'AND', 'OF']);
const tokens = (s) => normName(s).split(' ').filter((t) => t.length > 1 && !NOISE.has(t));
const coverage = (from, to) => (from.length === 0 || to.length === 0)
  ? 0 : from.reduce((s, t) => s + Math.max(...to.map((u) => tokenSim(t, u))), 0) / from.length;

/**
 * Typo-tolerant name similarity, weighted towards "every word the gate typed
 * appears in the Busy name" ("LOICE MAINA" → "LOISE WANJIKU MAINA").
 */
function nameSimilarity(gateName, busyName) {
  const g = tokens(gateName);
  const b = tokens(busyName);
  return 0.75 * coverage(g, b) + 0.25 * coverage(b, g);
}

module.exports = {
  CLOSED_STATUSES,
  MIGRATION_MISSING,
  hasLinkColumns,
  busyPartyCode,
  loadOpenEntries,
  suggestLinks,
  linkEntryToGrn,
  nameSimilarity,
};
