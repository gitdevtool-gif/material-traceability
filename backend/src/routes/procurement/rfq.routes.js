/**
 * RFQ Routes
 * Create RFQ (optionally bundling several requisitions/factories into
 * one combined request — see migration 016), dispatch to suppliers,
 * view dispatch history.
 *
 * Multi-requisition RFQs (2026-07-30): an RFQ is no longer locked to a
 * single Requisition. The relation now lives on Requisitions.RFQId
 * (many requisitions -> one RFQ). RFQs.RequisitionId is kept only for
 * historical rows and is never written to here anymore. See migration
 * 016_multi_requisition_rfq.sql for the full rationale.
 *
 * Per-supplier item assignment (2026-08-18): a supplier no longer has
 * to see every item across the linked requisition(s) — POST / now
 * accepts an optional `supplierItems: { [supplierId]: [requisitionItemId, ...] }`
 * map. When a supplier has an entry here, dbo.RFQDispatchItems rows are
 * written for that dispatch and only those items go into their email +
 * their /rfq/:token link (enforced in rfq-public.routes.js). A supplier
 * with NO entry (or an empty array) still sees ALL items — this is
 * backward compatible with every dispatch created before this change,
 * none of which have any RFQDispatchItems rows.
 *
 * Per-item RFQ linkage (2026-08-25): the RFQ<->Requisition relationship
 * now lives on dbo.RequisitionItems.RFQId, not just Requisitions.RFQId —
 * a requisition can have some items already sent in one RFQ while others
 * remain unsent, available for a later, separate RFQ. POST / accepts an
 * optional `itemIds` array to send only specific items; when provided it
 * takes over entirely from `requisitionIds` (the requisitions touched are
 * derived from the items themselves). Omitting `itemIds` keeps the
 * original "every item on the given requisitions" behavior, unchanged,
 * for existing callers (the bundle-RFQ page, quick-rfq). Eligibility is
 * now checked per item (RequisitionItems.RFQId IS NULL), not per
 * requisition — Requisitions.RFQId is updated as a best-effort "most
 * recent RFQ" display convenience only, never as a gate again.
 *
 * Add supplier to an existing RFQ (2026-08-25): POST /:rfqId/dispatch lets
 * procurement bring a NEW supplier into an RFQ that's already been sent —
 * e.g. a referral that comes in after the fact, or trying one more supplier
 * without re-issuing the whole RFQ. Same optional `itemIds` restriction as
 * the initial dispatch. `channel: 'phone'` with no email sent is also how
 * "Feed Quote Directly" works for a new supplier here — it just records the
 * dispatch so a quote can be captured immediately against it.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { sendRFQEmail, tokenExpiryDate } = require('../../services/rfq.service');
const config = require('../../config');

const router = express.Router();

async function generateRFQNumber(pool) {
  const year = new Date().getFullYear();
  const result = await pool.request()
    .input('prefix', sql.VarChar(20), `RFQ-${year}-%`)
    .query(`
      SELECT TOP 1
        ISNULL(MAX(TRY_CAST(RIGHT(RFQNumber, 4) AS INT)), 0) AS MaxNum
      FROM dbo.RFQs
      WHERE RFQNumber LIKE @prefix
    `);
  const next = (result.recordset[0].MaxNum || 0) + 1;
  return `RFQ-${year}-${String(next).padStart(4, '0')}`;
}

// Inserts dbo.RFQDispatchItems rows for a dispatch, if a non-empty,
// valid subset of items was assigned to that supplier. Silently does
// nothing for an empty/absent assignment — that's the "sees everything"
// case and needs no rows.
async function assignDispatchItems(pool, dispatchId, requisitionItemIds) {
  if (!requisitionItemIds || requisitionItemIds.length === 0) return;
  for (const itemId of requisitionItemIds) {
    await pool.request()
      .input('dispatchId', sql.Int, dispatchId)
      .input('itemId',     sql.Int, itemId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.RFQDispatchItems
          WHERE RFQDispatchId = @dispatchId AND RequisitionItemId = @itemId
        )
          INSERT INTO dbo.RFQDispatchItems (RFQDispatchId, RequisitionItemId)
          VALUES (@dispatchId, @itemId)
      `);
  }
}

// ── GET /api/procurement/rfq/dispatches/search ────────────────────────────────
// Search PENDING dispatches (no quotation captured yet) across ALL RFQs by
// supplier name — lets procurement staff find "which RFQ was this supplier
// sent" when a supplier calls in, without needing to know the RFQ number.
// Placed before "/:rfqId" — different path shape (2 segments), so no
// routing ambiguity, but kept first for clarity.
//
// Aggregated (STRING_AGG/SUM) since an RFQ dispatch can now be linked to
// several requisitions at once — one row per dispatch, not per requisition.
router.get('/dispatches/search', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const { supplier } = req.query;
    if (!supplier || !supplier.trim()) {
      return res.status(400).json({ error: 'supplier query parameter is required' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('search', sql.NVarChar(200), `%${supplier.trim()}%`)
      .query(`
        SELECT TOP 50
          d.RFQDispatchId, d.Channel, d.SentAt, d.TokenExpiresAt,
          s.SupplierId, s.SupplierName, s.Email, s.WhatsApp, s.Phone,
          rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt, rfq.Notes,
          STRING_AGG(r.BusyOrdNo, ', ') AS BusyOrdNo,
          STRING_AGG(r.MatCenter, ', ') AS MatCenter,
          SUM(ic.ItemCount) AS ItemCount
        FROM dbo.RFQDispatches d
        JOIN dbo.Suppliers s   ON s.SupplierId = d.SupplierId
        JOIN dbo.RFQs rfq      ON rfq.RFQId = d.RFQId
        LEFT JOIN dbo.Requisitions r ON r.RFQId = rfq.RFQId
        OUTER APPLY (
          SELECT COUNT(*) AS ItemCount FROM dbo.RequisitionItems WHERE RequisitionId = r.RequisitionId
        ) ic
        LEFT JOIN dbo.Quotations q ON q.RFQDispatchId = d.RFQDispatchId AND q.IsWithdrawn = 0
        WHERE q.QuotationId IS NULL
          AND s.SupplierName LIKE @search
        GROUP BY d.RFQDispatchId, d.Channel, d.SentAt, d.TokenExpiresAt,
                 s.SupplierId, s.SupplierName, s.Email, s.WhatsApp, s.Phone,
                 rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt, rfq.Notes
        ORDER BY MAX(d.SentAt) DESC
      `);

    res.json({ data: result.recordset });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/rfq ─────────────────────────────────────────────────
// Create an RFQ — optionally combining items from several requisitions
// (any factory/warehouse/mat-center) — and immediately dispatch to
// selected suppliers.
//
// Accepts EITHER:
//   requisitionIds: [1, 2, 3]   (new — combine any number of requisitions)
//   requisitionId:  1           (legacy — still works, treated as a single-item array)
//
// supplierItems (optional): { [supplierId]: [requisitionItemId, ...] }
// Restricts which items a given supplier is shown/asked to quote on. A
// supplier absent from this map, or mapped to an empty array, still sees
// every item across the linked requisitions.
router.post('/', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const {
      requisitionId,     // legacy single-id support
      requisitionIds,    // array of requisition ids — sends every eligible item on them
      itemIds,           // optional: specific RequisitionItemId list — takes over from requisitionIds when given
      deadlineAt,
      notes,
      supplierIds = [],
      channels = {},       // { [supplierId]: 'email' | 'whatsapp' | 'phone' }
      supplierItems = {},  // { [supplierId]: [requisitionItemId, ...] } — optional per-supplier subset
    } = req.body;

    const pool = await getPool();

    let items; // resolved RequisitionItems rows this RFQ will actually cover
    let parentRequisitionIds;

    if (Array.isArray(itemIds) && itemIds.length > 0) {
      // ── Specific-items path ── caller picked exactly which items go out.
      const itemIdList = [...new Set(itemIds.map((v) => parseInt(v, 10)).filter((n) => !isNaN(n)))];
      if (itemIdList.length === 0) {
        return res.status(400).json({ error: 'No valid item ids provided' });
      }
      const itemPlaceholders = itemIdList.map((_, i) => `@i${i}`).join(',');
      const itemCheckReq = pool.request();
      itemIdList.forEach((iid, i) => itemCheckReq.input(`i${i}`, sql.Int, iid));
      const itemCheck = await itemCheckReq.query(`
        SELECT ri.*, r.Status AS RequisitionStatus, r.BusyOrdNo
        FROM dbo.RequisitionItems ri
        JOIN dbo.Requisitions r ON r.RequisitionId = ri.RequisitionId
        WHERE ri.RequisitionItemId IN (${itemPlaceholders})
      `);
      if (itemCheck.recordset.length !== itemIdList.length) {
        return res.status(404).json({ error: 'One or more items were not found' });
      }
      const alreadyLinked = itemCheck.recordset.filter((it) => it.RFQId);
      if (alreadyLinked.length > 0) {
        return res.status(409).json({
          error: `Item(s) already part of an RFQ: ${alreadyLinked.map((it) => it.ItemName).join(', ')}`,
        });
      }
      const cancelled = itemCheck.recordset.filter((it) => it.RequisitionStatus === 'Cancelled');
      if (cancelled.length > 0) {
        return res.status(400).json({
          error: `Cannot create RFQ — requisition(s) cancelled: ${[...new Set(cancelled.map((it) => it.BusyOrdNo))].join(', ')}`,
        });
      }
      items = itemCheck.recordset;
      parentRequisitionIds = [...new Set(items.map((it) => it.RequisitionId))];
    } else {
      // ── Legacy path — every eligible item on the given requisition(s) ──
      const idsInput = Array.isArray(requisitionIds) && requisitionIds.length > 0
        ? requisitionIds
        : (requisitionId ? [requisitionId] : []);
      const ids = [...new Set(idsInput.map((v) => parseInt(v, 10)).filter((n) => !isNaN(n)))];
      if (ids.length === 0) {
        return res.status(400).json({ error: 'At least one requisition id (or itemIds) is required' });
      }

      const idPlaceholders = ids.map((_, i) => `@r${i}`).join(',');
      const checkRequest = pool.request();
      ids.forEach((rid, i) => checkRequest.input(`r${i}`, sql.Int, rid));
      const reqCheck = await checkRequest.query(`
        SELECT RequisitionId, Status, BusyOrdNo FROM dbo.Requisitions WHERE RequisitionId IN (${idPlaceholders})
      `);
      if (reqCheck.recordset.length !== ids.length) {
        return res.status(404).json({ error: 'One or more requisitions were not found' });
      }
      const cancelled = reqCheck.recordset.filter((r) => r.Status === 'Cancelled');
      if (cancelled.length > 0) {
        return res.status(400).json({
          error: `Cannot create RFQ — requisition(s) cancelled: ${cancelled.map((r) => r.BusyOrdNo).join(', ')}`,
        });
      }

      // Every currently-unsent, ops-approved item on these requisitions —
      // items already linked to an earlier RFQ (RFQId IS NOT NULL) are
      // silently skipped rather than erroring, so re-selecting a
      // partially-sent requisition on the bundle page still works: it
      // just picks up whatever's left.
      const itemsRequest = pool.request();
      ids.forEach((rid, i) => itemsRequest.input(`r${i}`, sql.Int, rid));
      const itemsResult = await itemsRequest.query(`
        SELECT ri.*
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        WHERE ri.RequisitionId IN (${idPlaceholders})
          AND ri.RFQId IS NULL
          AND ISNULL(ia.Decision, 'Approved') = 'Approved'
        ORDER BY ri.RequisitionItemId
      `);
      items = itemsResult.recordset;
      if (items.length === 0) {
        return res.status(400).json({ error: 'Every item on the selected requisition(s) is already part of an RFQ' });
      }
      parentRequisitionIds = ids;
    }

    if (supplierIds.length === 0) {
      return res.status(400).json({ error: 'At least one supplierId is required' });
    }

    // Generate RFQ number
    const rfqNumber = await generateRFQNumber(pool);

    // Insert RFQ header. RequisitionId is intentionally NULL — the relation
    // lives on RequisitionItems.RFQId (one RFQ, one-or-more items, possibly
    // spanning several requisitions).
    const rfqResult = await pool.request()
      .input('RFQNumber',      sql.VarChar(30),    rfqNumber)
      .input('IssuedAt',       sql.DateTime2,      new Date())
      .input('DeadlineAt',     sql.DateTime2,      deadlineAt ? new Date(deadlineAt) : null)
      .input('IssuedByUserId', sql.Int,            req.user.userId)
      .input('Notes',          sql.NVarChar(1000), notes || null)
      .query(`
        INSERT INTO dbo.RFQs
          (RequisitionId, RFQNumber, IssuedAt, DeadlineAt, IssuedByUserId, Notes)
        OUTPUT INSERTED.*
        VALUES
          (NULL, @RFQNumber, @IssuedAt, @DeadlineAt, @IssuedByUserId, @Notes)
      `);
    const rfq = rfqResult.recordset[0];

    // Link exactly the resolved items to this RFQ.
    const linkedItemIds = items.map((it) => it.RequisitionItemId);
    const linkItemPlaceholders = linkedItemIds.map((_, i) => `@li${i}`).join(',');
    const linkItemsReq = pool.request().input('rfqId', sql.Int, rfq.RFQId);
    linkedItemIds.forEach((iid, i) => linkItemsReq.input(`li${i}`, sql.Int, iid));
    await linkItemsReq.query(`
      UPDATE dbo.RequisitionItems SET RFQId = @rfqId WHERE RequisitionItemId IN (${linkItemPlaceholders})
    `);

    // Requisitions.Status/RFQId are now informational convenience fields,
    // not gates — Status only advances past 'Pending' the first time it
    // gets ANY item sent (never regressed if it's already further along
    // from an earlier RFQ), and RFQId is best-effort "most recent RFQ".
    const parentPlaceholders = parentRequisitionIds.map((_, i) => `@p${i}`).join(',');
    const parentUpdateReq = pool.request().input('rfqId', sql.Int, rfq.RFQId);
    parentRequisitionIds.forEach((rid, i) => parentUpdateReq.input(`p${i}`, sql.Int, rid));
    await parentUpdateReq.query(`
      UPDATE dbo.Requisitions
      SET RFQId = @rfqId,
          Status = CASE WHEN Status = 'Pending' THEN 'RFQSent' ELSE Status END,
          UpdatedAt = GETUTCDATE()
      WHERE RequisitionId IN (${parentPlaceholders})
    `);

    const validItemIds = new Set(items.map((it) => it.RequisitionItemId));

    // Fetch suppliers
    const supplierIdList = supplierIds.map((id) => parseInt(id, 10)).filter(Boolean);
    const suppliersResult = await pool.request()
      .query(`
        SELECT SupplierId, SupplierName, Email, WhatsApp, Phone
        FROM dbo.Suppliers
        WHERE SupplierId IN (${supplierIdList.join(',')})
          AND IsActive = 1
      `);
    const suppliers = suppliersResult.recordset;

    const tokenExpiry = tokenExpiryDate();
    const dispatches = [];
    const emailResults = [];

    for (const supplier of suppliers) {
      const channel = channels[supplier.SupplierId] || 'email';

      // Insert dispatch row — DB generates the UUID token
      const dispatchResult = await pool.request()
        .input('RFQId',         sql.Int,         rfq.RFQId)
        .input('SupplierId',    sql.Int,         supplier.SupplierId)
        .input('Channel',       sql.VarChar(20), channel)
        .input('SentAt',        sql.DateTime2,   new Date())
        .input('TokenExpires',  sql.DateTime2,   tokenExpiry)
        .input('SentByUserId',  sql.Int,         req.user.userId)
        .query(`
          INSERT INTO dbo.RFQDispatches
            (RFQId, SupplierId, Channel, SentAt, TokenExpiresAt, SentByUserId)
          OUTPUT INSERTED.*
          VALUES
            (@RFQId, @SupplierId, @Channel, @SentAt, @TokenExpires, @SentByUserId)
        `);
      const dispatch = dispatchResult.recordset[0];
      dispatches.push(dispatch);

      // Resolve this supplier's item subset, if any was provided —
      // filtered against the real item set so a stray/invalid id in the
      // request body can't leak an item from elsewhere in.
      const rawAssigned = Array.isArray(supplierItems[supplier.SupplierId])
        ? supplierItems[supplier.SupplierId]
        : [];
      const assignedIds = rawAssigned
        .map((v) => parseInt(v, 10))
        .filter((n) => validItemIds.has(n));

      await assignDispatchItems(pool, dispatch.RFQDispatchId, assignedIds);

      const supplierItemsForEmail = assignedIds.length > 0
        ? items.filter((it) => assignedIds.includes(it.RequisitionItemId))
        : items;

      // Send email if channel is email and supplier has an email address
      if (channel === 'email' && supplier.Email) {
        const submitUrl = `${config.appUrl}/supplier-quote/${dispatch.Token}`;
        const sent = await sendRFQEmail({
          to:           supplier.Email,
          supplierName: supplier.SupplierName,
          rfqNumber,
          deadline:     deadlineAt,
          items:        supplierItemsForEmail,
          submitUrl,
          notes,
        });
        emailResults.push({ supplierId: supplier.SupplierId, sent });
      }
    }

    res.status(201).json({
      rfq,
      requisitionIds: parentRequisitionIds,
      itemIds: linkedItemIds,
      dispatches,
      emailResults,
    });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/rfq/:rfqId ──────────────────────────────────────────
// Returns the RFQ plus its full list of linked requisitions (one or more).
// Also mirrors a few convenience fields (BusyOrdNo, Warehouse, MatCenter,
// BusyDate, RequisitionId) at the top level for any older frontend code
// still reading them off a single requisition — combined across all linked
// requisitions where there's more than one.
//
// Per-item RFQ linkage: "linked requisitions" is now derived from WHICH
// ITEMS actually belong to this RFQ (RequisitionItems.RFQId), not from
// Requisitions.RFQId — a requisition split across two RFQs must only show
// up here for the one that actually has items in it.
router.get('/:rfqId', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const rfqId = parseInt(req.params.rfqId, 10);
    const pool = await getPool();

    const [rfqResult, requisitionsResult, dispatchesResult, dispatchItemsResult] = await Promise.all([
      pool.request().input('id', sql.Int, rfqId).query(`
        SELECT rfq.*, u.FullName AS IssuedByName
        FROM dbo.RFQs rfq
        LEFT JOIN dbo.Users u ON u.UserId = rfq.IssuedByUserId
        WHERE rfq.RFQId = @id
      `),
      pool.request().input('id', sql.Int, rfqId).query(`
        SELECT DISTINCT r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter, r.Status
        FROM dbo.Requisitions r
        JOIN dbo.RequisitionItems ri ON ri.RequisitionId = r.RequisitionId
        WHERE ri.RFQId = @id
        ORDER BY r.BusyOrdNo
      `),
      pool.request().input('id', sql.Int, rfqId).query(`
        SELECT d.*, s.SupplierName, s.Email, s.WhatsApp, s.Phone,
               CONVERT(VARCHAR(36), d.Token) AS TokenStr,
               q.QuotationId, q.TotalAmount, q.SubmittedAt, q.IsWithdrawn,
               (SELECT COUNT(*) FROM dbo.RFQDispatchItems di WHERE di.RFQDispatchId = d.RFQDispatchId) AS AssignedItemCount
        FROM dbo.RFQDispatches d
        JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
        LEFT JOIN dbo.Quotations q ON q.RFQDispatchId = d.RFQDispatchId AND q.IsWithdrawn = 0
        WHERE d.RFQId = @id
        ORDER BY s.SupplierName
      `),
      // Per-dispatch item restriction (dbo.RFQDispatchItems) — grouped in
      // JS below rather than STRING_AGG'd in SQL so the frontend gets a
      // real array of ids to filter the quote-capture form's line items
      // against, not a string it would have to re-parse.
      pool.request().input('id', sql.Int, rfqId).query(`
        SELECT di.RFQDispatchId, di.RequisitionItemId
        FROM dbo.RFQDispatchItems di
        JOIN dbo.RFQDispatches d ON d.RFQDispatchId = di.RFQDispatchId
        WHERE d.RFQId = @id
      `),
    ]);

    if (rfqResult.recordset.length === 0) {
      return res.status(404).json({ error: 'RFQ not found' });
    }

    const rfq = rfqResult.recordset[0];
    const requisitions = requisitionsResult.recordset;
    rfq.requisitions = requisitions;

    if (requisitions.length > 0) {
      rfq.BusyOrdNo     = requisitions.map((r) => r.BusyOrdNo).join(', ');
      rfq.BusyDate      = requisitions[0].BusyDate;
      rfq.Warehouse     = [...new Set(requisitions.map((r) => r.Warehouse).filter(Boolean))].join(', ') || null;
      rfq.MatCenter     = [...new Set(requisitions.map((r) => r.MatCenter).filter(Boolean))].join(', ') || null;
      rfq.RequisitionId = requisitions[0].RequisitionId; // legacy convenience — first linked requisition
    }

    const assignedItemsByDispatch = {};
    for (const row of dispatchItemsResult.recordset) {
      (assignedItemsByDispatch[row.RFQDispatchId] ||= []).push(row.RequisitionItemId);
    }

    // AssignedItemCount = 0 means that dispatch has no RFQDispatchItems
    // rows, i.e. that supplier sees ALL items — surfaced to the frontend
    // as `itemsRestricted` (+ the actual `AssignedItemIds`) so it can show
    // "3 of 8 items" vs "All items" AND, on the quote-capture form, only
    // let procurement price/mark-unavailable the items this dispatch was
    // actually scoped to.
    rfq.dispatches = dispatchesResult.recordset.map((d) => ({
      ...d,
      itemsRestricted: d.AssignedItemCount > 0,
      AssignedItemIds: assignedItemsByDispatch[d.RFQDispatchId] || [],
    }));
    res.json(rfq);
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/rfq/:rfqId/items/:itemId ───────────────────────────
// Procurement can correct the requested Qty and/or ItemName of an item
// already sent out on this RFQ (2026-09-21, ItemName added 2026-09-21) —
// e.g. the original ask was wrong, or the wrong item name was typed/
// picked, and needs fixing before award. Follow up with POST
// /:rfqId/resend per dispatch to actually notify the supplier(s) of the
// correction — /resend already reads the live Qty/ItemName off
// dbo.RequisitionItems, so no separate "resend with correction" endpoint
// is needed. ItemName is a free-text correction here (not re-validated
// against the Busy item catalog like requisition-create.routes.js does)
// since this is a one-off error fix, not a fresh pick.
//
// Blocked once the Director has already approved a winner for this RFQ
// (dbo.QuoteEvaluations exists) — that decision is final; the existing
// "undo approval" (DELETE /api/procurement/evaluation/:rfqId) must be
// used first if it truly needs reopening.
//
// 2026-09-21 bug fix: this used to auto-withdraw (IsWithdrawn = 1) every
// quotation that already priced the edited item. IsWithdrawn lives on the
// WHOLE Quotation, not per line — on an RFQ where every supplier quoted
// every item (the common case), editing a single item's qty wiped out
// EVERY supplier's entire quote in one go. Live incident: RFQ-2026-0066
// had all 14 of its quotations withdrawn from one qty edit, which dropped
// its live-quote count to 0 and silently removed the whole RFQ from the
// Director's evaluation queue (GET /pending requires >= 1 live quote) —
// exactly as if nobody had quoted at all, even though 14 real quotes
// existed. Fixed by no longer touching IsWithdrawn here at all: the qty/
// name correction is applied, and any supplier who already priced this
// item is only reported back (see `affectedQuotations` below) so
// Procurement can judge whether to resend and ask for confirmation —
// nothing is auto-invalidated or hidden from the Director.
router.patch('/:rfqId/items/:itemId', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const rfqId  = parseInt(req.params.rfqId, 10);
    const itemId = parseInt(req.params.itemId, 10);

    const hasQty      = req.body.qty !== undefined && req.body.qty !== null && req.body.qty !== '';
    const hasItemName = req.body.itemName !== undefined && req.body.itemName !== null;
    if (!hasQty && !hasItemName) {
      return res.status(400).json({ error: 'Provide qty and/or itemName to update' });
    }

    let qty = null;
    if (hasQty) {
      qty = parseFloat(req.body.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'qty must be a positive number' });
      }
    }

    let itemName = null;
    if (hasItemName) {
      itemName = String(req.body.itemName).trim();
      if (!itemName) {
        return res.status(400).json({ error: 'itemName cannot be blank' });
      }
    }

    const pool = await getPool();

    const itemResult = await pool.request()
      .input('itemId', sql.Int, itemId)
      .input('rfqId',  sql.Int, rfqId)
      .query('SELECT RequisitionItemId, Qty, ItemName FROM dbo.RequisitionItems WHERE RequisitionItemId = @itemId AND RFQId = @rfqId');
    if (itemResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Item not found on this RFQ' });
    }

    const evalResult = await pool.request().input('rfqId', sql.Int, rfqId)
      .query('SELECT QuoteEvaluationId FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');
    if (evalResult.recordset.length > 0) {
      return res.status(400).json({ error: 'This RFQ has already been awarded — undo the approval first if this item truly needs correcting.' });
    }

    // Only actually changed fields trigger the "withdraw stale quotes"
    // side effect below — a no-op save (edit opened, nothing changed,
    // Save clicked) must not needlessly wipe out live supplier quotes.
    const qtyChanged  = hasQty && qty !== Number(itemResult.recordset[0].Qty);
    const nameChanged = hasItemName && itemName !== itemResult.recordset[0].ItemName;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      if (qtyChanged || nameChanged) {
        const updateRequest = new sql.Request(transaction).input('itemId', sql.Int, itemId);
        const setClauses = [];
        if (qtyChanged) {
          updateRequest.input('qty', sql.Decimal(12, 2), qty);
          setClauses.push('Qty = @qty');
        }
        if (nameChanged) {
          updateRequest.input('itemName', sql.NVarChar(200), itemName);
          setClauses.push('ItemName = @itemName');
        }
        await updateRequest.query(`UPDATE dbo.RequisitionItems SET ${setClauses.join(', ')} WHERE RequisitionItemId = @itemId`);
      }

      // Read-only: report who already quoted this item so Procurement can
      // decide whether to follow up, WITHOUT touching IsWithdrawn (see the
      // bug-fix note above the route for why auto-withdrawing broke the
      // Director's evaluation queue).
      const affectedResult = (qtyChanged || nameChanged)
        ? await new sql.Request(transaction)
            .input('itemId', sql.Int, itemId)
            .query(`
              SELECT q.QuotationId, q.SupplierId, s.SupplierName, q.RFQDispatchId
              FROM dbo.Quotations q
              JOIN dbo.QuotationLineItems li ON li.QuotationId = q.QuotationId
              JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
              WHERE li.RequisitionItemId = @itemId AND q.IsWithdrawn = 0
            `)
        : { recordset: [] };

      await transaction.commit();
      res.json({
        ok: true,
        itemId,
        qty: hasQty ? qty : itemResult.recordset[0].Qty,
        itemName: hasItemName ? itemName : itemResult.recordset[0].ItemName,
        previousQty: itemResult.recordset[0].Qty,
        previousItemName: itemResult.recordset[0].ItemName,
        affectedQuotations: affectedResult.recordset,
      });
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

// ── POST /api/procurement/rfq/:rfqId/resend ───────────────────────────────────
// Re-send email to a specific dispatch (by dispatchId) — useful for reminders.
// Items now come from ALL requisitions linked to this RFQ, not just one —
// UNLESS that dispatch has a restricted item subset (dbo.RFQDispatchItems),
// in which case only those items are resent, same as the original send.
router.post('/:rfqId/resend', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const rfqId       = parseInt(req.params.rfqId, 10);
    const { dispatchId } = req.body;
    if (!dispatchId) return res.status(400).json({ error: 'dispatchId is required' });

    const pool = await getPool();

    const result = await pool.request()
      .input('rfqId',      sql.Int, rfqId)
      .input('dispatchId', sql.Int, parseInt(dispatchId, 10))
      .query(`
        SELECT d.*, s.Email, s.SupplierName, CONVERT(VARCHAR(36), d.Token) AS TokenStr,
               rfq.RFQNumber, rfq.DeadlineAt, rfq.Notes
        FROM dbo.RFQDispatches d
        JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
        JOIN dbo.RFQs rfq ON rfq.RFQId = d.RFQId
        WHERE d.RFQId = @rfqId AND d.RFQDispatchId = @dispatchId
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Dispatch not found' });
    }
    const dispatch = result.recordset[0];
    if (!dispatch.Email) {
      return res.status(400).json({ error: 'Supplier has no email address' });
    }

    // Fetch items actually belonging to THIS RFQ (RequisitionItems.RFQId,
    // not "all items of any requisition touched by this RFQ" — a
    // requisition can have other items sent in a different RFQ, which
    // must never leak into this resend). Same ops-rejected exclusion as
    // the original send, so a resend can't reintroduce an item the Ops
    // Manager turned down.
    const itemsResult = await pool.request()
      .input('rfqId', sql.Int, rfqId)
      .query(`
        SELECT ri.*
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        WHERE ri.RFQId = @rfqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
        ORDER BY ri.RequisitionItemId
      `);

    // If this dispatch has an assigned item subset, resend only those.
    const assignedResult = await pool.request()
      .input('dispatchId', sql.Int, dispatch.RFQDispatchId)
      .query('SELECT RequisitionItemId FROM dbo.RFQDispatchItems WHERE RFQDispatchId = @dispatchId');
    const assignedIds = new Set(assignedResult.recordset.map((r) => r.RequisitionItemId));
    const itemsToSend = assignedIds.size > 0
      ? itemsResult.recordset.filter((it) => assignedIds.has(it.RequisitionItemId))
      : itemsResult.recordset;

    const submitUrl = `${config.appUrl}/supplier-quote/${dispatch.TokenStr}`;
    const sent = await sendRFQEmail({
      to:           dispatch.Email,
      supplierName: dispatch.SupplierName,
      rfqNumber:    dispatch.RFQNumber,
      deadline:     dispatch.DeadlineAt,
      items:        itemsToSend,
      submitUrl,
      notes:        dispatch.Notes,
    });

    // Update SentAt
    await pool.request()
      .input('id', sql.Int, dispatch.RFQDispatchId)
      .query(`UPDATE dbo.RFQDispatches SET SentAt = GETUTCDATE() WHERE RFQDispatchId = @id`);

    res.json({ sent });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/rfq/:rfqId/dispatch ─────────────────────────────────
// Add one more supplier dispatch to an ALREADY-ISSUED RFQ. Body:
//   supplierId  (required)
//   channel     'email' | 'whatsapp' | 'phone' (default 'email')
//   itemIds     optional subset of this RFQ's item ids — omit (or send all
//               of them) to let the supplier see every item on the RFQ
// A supplier already dispatched on this RFQ is rejected (409) — use resend
// for that instead. Mirrors the dispatch-creation half of POST /.
router.post('/:rfqId/dispatch', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const rfqId = parseInt(req.params.rfqId, 10);
    const { supplierId, channel = 'email', itemIds } = req.body;
    const sid = parseInt(supplierId, 10);
    if (!sid) return res.status(400).json({ error: 'supplierId is required' });

    const pool = await getPool();

    const rfqResult = await pool.request().input('id', sql.Int, rfqId).query(
      'SELECT RFQId, RFQNumber, DeadlineAt, Notes FROM dbo.RFQs WHERE RFQId = @id'
    );
    if (rfqResult.recordset.length === 0) return res.status(404).json({ error: 'RFQ not found' });
    const rfq = rfqResult.recordset[0];

    const supplierResult = await pool.request().input('id', sql.Int, sid).query(
      'SELECT SupplierId, SupplierName, Email, WhatsApp, Phone, IsActive FROM dbo.Suppliers WHERE SupplierId = @id'
    );
    if (supplierResult.recordset.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    const supplier = supplierResult.recordset[0];
    if (!supplier.IsActive) return res.status(400).json({ error: 'Supplier is not active' });

    const dupCheck = await pool.request()
      .input('rfqId', sql.Int, rfqId)
      .input('sid', sql.Int, sid)
      .query('SELECT RFQDispatchId FROM dbo.RFQDispatches WHERE RFQId = @rfqId AND SupplierId = @sid');
    if (dupCheck.recordset.length > 0) {
      return res.status(409).json({ error: `${supplier.SupplierName} is already dispatched on this RFQ — use Resend instead.` });
    }

    // Items actually on this RFQ — same ops-approval exclusion used
    // everywhere else this RFQ's item set is resolved.
    const itemsResult = await pool.request().input('rfqId', sql.Int, rfqId).query(`
      SELECT ri.*
      FROM dbo.RequisitionItems ri
      LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
      WHERE ri.RFQId = @rfqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
      ORDER BY ri.RequisitionItemId
    `);
    const rfqItems = itemsResult.recordset;
    if (rfqItems.length === 0) return res.status(400).json({ error: 'This RFQ has no items' });
    const validItemIds = new Set(rfqItems.map((it) => it.RequisitionItemId));

    const assignedIds = Array.isArray(itemIds)
      ? itemIds.map((v) => parseInt(v, 10)).filter((n) => validItemIds.has(n))
      : [];

    const tokenExpiry = tokenExpiryDate();
    const dispatchResult = await pool.request()
      .input('RFQId',        sql.Int,         rfqId)
      .input('SupplierId',   sql.Int,         sid)
      .input('Channel',      sql.VarChar(20), channel)
      .input('SentAt',       sql.DateTime2,   new Date())
      .input('TokenExpires', sql.DateTime2,   tokenExpiry)
      .input('SentByUserId', sql.Int,         req.user.userId)
      .query(`
        INSERT INTO dbo.RFQDispatches
          (RFQId, SupplierId, Channel, SentAt, TokenExpiresAt, SentByUserId)
        OUTPUT INSERTED.*
        VALUES
          (@RFQId, @SupplierId, @Channel, @SentAt, @TokenExpires, @SentByUserId)
      `);
    const dispatch = dispatchResult.recordset[0];

    await assignDispatchItems(pool, dispatch.RFQDispatchId, assignedIds);

    let sent = null;
    if (channel === 'email' && supplier.Email) {
      const itemsForEmail = assignedIds.length > 0
        ? rfqItems.filter((it) => assignedIds.includes(it.RequisitionItemId))
        : rfqItems;
      const submitUrl = `${config.appUrl}/supplier-quote/${dispatch.Token}`;
      sent = await sendRFQEmail({
        to:           supplier.Email,
        supplierName: supplier.SupplierName,
        rfqNumber:    rfq.RFQNumber,
        deadline:     rfq.DeadlineAt,
        items:        itemsForEmail,
        submitUrl,
        notes:        rfq.Notes,
      });
    }

    res.status(201).json({ dispatch, sent });
  } catch (err) { next(err); }
});

module.exports = router;