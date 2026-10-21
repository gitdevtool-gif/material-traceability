/**
 * Evaluation Routes
 * Director views ranked comparison of quotations with ERP benchmarks,
 * then approves winners on a PER-ITEM basis (migration 020) — different
 * suppliers can win different requisition items on the same RFQ.
 *
 * dbo.QuoteEvaluations is still the evaluation "header" (one row per RFQ
 * evaluation event). New code never writes WinningQuotationId — the actual
 * decision lives in dbo.QuoteEvaluationItems, one row per RequisitionItem,
 * with UnitPrice/Qty/SupplierId snapshotted at award time. Historical rows
 * with WinningQuotationId set and no QuoteEvaluationItems are still read
 * and rendered as "legacy full-award" evaluations everywhere below.
 *
 * Multi-requisition RFQs (2026-07-30): unchanged — still joined via
 * r.RFQId = rfq.RFQId, aggregated with STRING_AGG/MIN where several
 * requisitions are linked.
 *
 * Undo approval: DELETE /:rfqId removes the QuoteEvaluations row (cascades
 * to QuoteEvaluationItems per FK) and reverts every linked requisition back
 * to 'QuotesReceived'. Blocked if ANY supplier's LPO has already been
 * reconciled for this RFQ — a partial reconciliation mid-undo would leave
 * Busy and this system disagreeing about who won what.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { getErpPool, sql: erpSql } = require('../../erpDb');
const { authenticate, authorize } = require('../../middleware/auth');
const { scoreQuotations } = require('../../services/quote-scoring.service');

const router = express.Router();

const REVERT_STATUS = 'QuotesReceived';

// ── GET /api/procurement/evaluation/pending ───────────────────────────────
// RFQs that still need Director attention: either never evaluated at
// all, OR previously partially-evaluated with some item(s) still on hold
// (dbo.RFQItemHolds) — a hold keeps the RFQ in this queue even though a
// QuoteEvaluations row already exists for it, so the Director doesn't
// lose track of items waiting on a late supplier response.
router.get('/pending', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const pool = await getPool();
    // BusyOrdNo/MatCenter derived via reqAgg (the requisitions that
    // actually OWN an item in this RFQ, per RequisitionItems.RFQId) —
    // not a direct Requisitions.RFQId join, which is now just "most
    // recent RFQ" and could pull in an unrelated requisition or miss one
    // whose items came from an earlier RFQ than its current pointer.
    const result = await pool.request().query(`
      SELECT rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt, rfq.IssuedAt,
             reqAgg.BusyOrdNo, reqAgg.BusyDate, reqAgg.MatCenter,
             MAX(qc.QuoteCount)     AS QuoteCount,
             MAX(sup.SupplierNames) AS SupplierNames,
             MAX(hc.HeldCount)      AS HeldCount
      FROM dbo.RFQs rfq
      CROSS APPLY (
        SELECT STRING_AGG(r.BusyOrdNo, ', ') AS BusyOrdNo,
               MIN(r.BusyDate)               AS BusyDate,
               STRING_AGG(r.MatCenter, ', ')  AS MatCenter
        FROM dbo.Requisitions r
        WHERE r.RequisitionId IN (
          SELECT DISTINCT ri.RequisitionId FROM dbo.RequisitionItems ri WHERE ri.RFQId = rfq.RFQId
        )
      ) reqAgg
      CROSS APPLY (
        SELECT COUNT(DISTINCT q.QuotationId) AS QuoteCount
        FROM dbo.Quotations q
        WHERE q.RFQId = rfq.RFQId AND q.IsWithdrawn = 0
      ) qc
      CROSS APPLY (
        SELECT STRING_AGG(sn.SupplierName, ', ') WITHIN GROUP (ORDER BY sn.SupplierName) AS SupplierNames
        FROM (
          SELECT DISTINCT s.SupplierName
          FROM dbo.Quotations q2
          JOIN dbo.Suppliers s ON s.SupplierId = q2.SupplierId
          WHERE q2.RFQId = rfq.RFQId AND q2.IsWithdrawn = 0
        ) sn
      ) sup
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.RFQId = rfq.RFQId
      OUTER APPLY (
        SELECT COUNT(*) AS HeldCount FROM dbo.RFQItemHolds h WHERE h.RFQId = rfq.RFQId
      ) hc
      WHERE ev.QuoteEvaluationId IS NULL OR hc.HeldCount > 0
      GROUP BY rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt, rfq.IssuedAt,
               reqAgg.BusyOrdNo, reqAgg.BusyDate, reqAgg.MatCenter
      HAVING MAX(qc.QuoteCount) >= 1
      ORDER BY rfq.DeadlineAt ASC
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/evaluation/held ──────────────────────────────────
// Procurement's follow-up queue: every item a Director has put on hold
// (dbo.RFQItemHolds), together with the supplier(s) who still need to be
// chased for a price on THAT item — so Procurement knows exactly who to
// call/email instead of re-reading the whole RFQ. A supplier appears here
// if they were dispatched this item (or the whole RFQ, when no per-item
// restriction was set — see rfq.routes.js's supplierItems handling) and
// haven't yet priced it:
//   'no-response'   → hasn't submitted any quotation for this RFQ at all
//   'not-priced'    → submitted a quotation, but left this item blank
//   'not-available' → submitted a quotation, explicitly marked this item unavailable
router.get('/held', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const pool = await getPool();

    // BusyOrdNo/MatCenter come straight from the held item's OWN parent
    // requisition (rq below) — a hold is always for one specific item, so
    // there's no aggregation to do, and no risk of pulling in an
    // unrelated requisition the way a blanket "requisitions on this RFQ"
    // join could.
    const holdsResult = await pool.request().query(`
      SELECT h.RFQItemHoldId, h.RFQId, h.RequisitionItemId, h.Reason, h.HeldAt,
             hu.FullName AS HeldByName,
             rfq.RFQNumber, rfq.DeadlineAt,
             rq.BusyOrdNo, rq.MatCenter,
             ri.ItemName, ri.ItemCode, ri.Qty AS RequiredQty, ri.Category
      FROM dbo.RFQItemHolds h
      JOIN dbo.RFQs rfq ON rfq.RFQId = h.RFQId
      JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = h.RequisitionItemId
      JOIN dbo.Requisitions rq ON rq.RequisitionId = ri.RequisitionId
      LEFT JOIN dbo.Users hu ON hu.UserId = h.HeldByUserId
      ORDER BY h.HeldAt DESC
    `);
    const holds = holdsResult.recordset;
    if (holds.length === 0) return res.json([]);

    const rfqIds = [...new Set(holds.map((h) => h.RFQId))];
    const itemIds = [...new Set(holds.map((h) => h.RequisitionItemId))];

    // Every dispatch for every RFQ involved, plus whether it's restricted
    // to a specific item subset (dbo.RFQDispatchItems) — a dispatch with
    // no rows there sees/can quote on every item, unchanged behavior.
    const rfqPlaceholders = rfqIds.map((_, i) => `@r${i}`).join(',');
    const dispatchReq = pool.request();
    rfqIds.forEach((id, i) => dispatchReq.input(`r${i}`, sql.Int, id));
    const dispatchResult = await dispatchReq.query(`
      SELECT d.RFQDispatchId, d.RFQId, d.SupplierId, d.SentAt, d.Channel, d.TokenExpiresAt,
             s.SupplierName, s.Email, s.Phone, s.WhatsApp,
             q.QuotationId
      FROM dbo.RFQDispatches d
      JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
      LEFT JOIN dbo.Quotations q ON q.RFQDispatchId = d.RFQDispatchId AND q.IsWithdrawn = 0
      WHERE d.RFQId IN (${rfqPlaceholders})
    `);

    const dispatchItemsReq = pool.request();
    rfqIds.forEach((id, i) => dispatchItemsReq.input(`r${i}`, sql.Int, id));
    const dispatchItemsResult = await dispatchItemsReq.query(`
      SELECT di.RFQDispatchId, di.RequisitionItemId
      FROM dbo.RFQDispatchItems di
      JOIN dbo.RFQDispatches d ON d.RFQDispatchId = di.RFQDispatchId
      WHERE d.RFQId IN (${rfqPlaceholders})
    `);
    const restrictedItemsByDispatch = new Map(); // dispatchId -> Set(itemId)
    for (const row of dispatchItemsResult.recordset) {
      if (!restrictedItemsByDispatch.has(row.RFQDispatchId)) restrictedItemsByDispatch.set(row.RFQDispatchId, new Set());
      restrictedItemsByDispatch.get(row.RFQDispatchId).add(row.RequisitionItemId);
    }

    // Per-supplier pricing status on exactly these held items.
    const itemPlaceholders = itemIds.map((_, i) => `@i${i}`).join(',');
    const lineReq = pool.request();
    itemIds.forEach((id, i) => lineReq.input(`i${i}`, sql.Int, id));
    const lineResult = await lineReq.query(`
      SELECT q.SupplierId, li.RequisitionItemId, li.UnitPrice, li.IsNotAvailable
      FROM dbo.QuotationLineItems li
      JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId AND q.IsWithdrawn = 0
      WHERE li.RequisitionItemId IN (${itemPlaceholders})
    `);
    const lineBySupplierItem = new Map(); // `${supplierId}:${itemId}` -> line
    for (const row of lineResult.recordset) {
      lineBySupplierItem.set(`${row.SupplierId}:${row.RequisitionItemId}`, row);
    }

    const dispatchesByRfq = new Map();
    for (const d of dispatchResult.recordset) {
      if (!dispatchesByRfq.has(d.RFQId)) dispatchesByRfq.set(d.RFQId, []);
      dispatchesByRfq.get(d.RFQId).push(d);
    }

    const result = holds.map((h) => {
      const dispatches = dispatchesByRfq.get(h.RFQId) || [];
      const suppliers = dispatches
        .filter((d) => {
          const restricted = restrictedItemsByDispatch.get(d.RFQDispatchId);
          return !restricted || restricted.has(h.RequisitionItemId);
        })
        .map((d) => {
          const line = lineBySupplierItem.get(`${d.SupplierId}:${h.RequisitionItemId}`);
          let status;
          if (!d.QuotationId) status = 'no-response';
          else if (!line || line.UnitPrice == null) status = line?.IsNotAvailable ? 'not-available' : 'not-priced';
          else status = 'priced'; // quoted this item but Director still held it (e.g. comparing against a pending quote elsewhere)
          return {
            RFQDispatchId: d.RFQDispatchId,
            SupplierId: d.SupplierId,
            SupplierName: d.SupplierName,
            Email: d.Email,
            Phone: d.Phone,
            WhatsApp: d.WhatsApp,
            SentAt: d.SentAt,
            Channel: d.Channel,
            isExpired: !!(d.TokenExpiresAt && new Date(d.TokenExpiresAt) < new Date()),
            status,
          };
        })
        .filter((s) => s.status !== 'priced') // nothing to follow up on
        .sort((a, b) => a.SupplierName.localeCompare(b.SupplierName));

      return {
        RFQItemHoldId: h.RFQItemHoldId,
        RFQId: h.RFQId,
        RFQNumber: h.RFQNumber,
        DeadlineAt: h.DeadlineAt,
        BusyOrdNo: h.BusyOrdNo,
        MatCenter: h.MatCenter,
        RequisitionItemId: h.RequisitionItemId,
        ItemName: h.ItemName,
        RequiredQty: h.RequiredQty,
        Category: h.Category,
        Reason: h.Reason,
        HeldAt: h.HeldAt,
        HeldByName: h.HeldByName,
        suppliers,
      };
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/evaluation/held/:requisitionItemId/cancel ─────────
// Procurement gives up on a stuck held item — e.g. no supplier has priced
// it after repeated chasing — instead of it sitting on the follow-up queue
// indefinitely. Reuses dbo.RequisitionItemApprovals (Decision='Rejected')
// rather than a new table: it's the exact same "this item is decided, stop
// asking for a decision on it" mechanism the Ops Manager gate already uses
// pre-RFQ, and every place that already respects it (this RFQ's own
// evaluation requirement check above, the supplier's own public portal)
// picks this up for free — the item silently drops off what the supplier
// still sees/can submit for too. If this was the requisition's last
// remaining active item, the whole requisition is cancelled as a side
// effect (mirrors RejectedByOps/RejectedByCentralStores dead-ending when
// zero items survive elsewhere in this system).
router.post('/held/:requisitionItemId/cancel', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const requisitionItemId = parseInt(req.params.requisitionItemId, 10);
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'A reason is required to cancel this item' });
    }

    const pool = await getPool();
    const itemResult = await pool.request().input('id', sql.Int, requisitionItemId).query(
      'SELECT RequisitionItemId, RequisitionId, RFQId, ItemName FROM dbo.RequisitionItems WHERE RequisitionItemId = @id'
    );
    if (!itemResult.recordset[0]) return res.status(404).json({ error: 'Item not found' });
    const item = itemResult.recordset[0];
    if (!item.RFQId) return res.status(400).json({ error: 'This item is not linked to an RFQ' });

    const holdCheck = await pool.request()
      .input('rfqId', sql.Int, item.RFQId).input('itemId', sql.Int, requisitionItemId)
      .query('SELECT RFQItemHoldId FROM dbo.RFQItemHolds WHERE RFQId = @rfqId AND RequisitionItemId = @itemId');
    if (holdCheck.recordset.length === 0) {
      return res.status(400).json({ error: 'This item is not currently on hold' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input('rfqId', sql.Int, item.RFQId).input('itemId', sql.Int, requisitionItemId)
        .query('DELETE FROM dbo.RFQItemHolds WHERE RFQId = @rfqId AND RequisitionItemId = @itemId');

      // Upsert: clear any prior (pre-RFQ Ops) decision row for this item,
      // then insert the cancellation fresh — same pattern used everywhere
      // else this table is written to.
      await new sql.Request(transaction).input('itemId', sql.Int, requisitionItemId)
        .query('DELETE FROM dbo.RequisitionItemApprovals WHERE RequisitionItemId = @itemId');
      await new sql.Request(transaction)
        .input('itemId', sql.Int, requisitionItemId)
        .input('reason', sql.NVarChar(500), `Cancelled by Procurement: ${reason.trim()}`)
        .input('userId', sql.Int, req.user.userId)
        .query(`
          INSERT INTO dbo.RequisitionItemApprovals (RequisitionItemId, Decision, RejectionReason, DecidedByUserId)
          VALUES (@itemId, 'Rejected', @reason, @userId)
        `);

      // If that was the requisition's last active (non-rejected) item,
      // the requisition itself has nothing left to procure.
      const remainingActive = await new sql.Request(transaction).input('reqId', sql.Int, item.RequisitionId).query(`
        SELECT COUNT(*) AS cnt
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        WHERE ri.RequisitionId = @reqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
      `);
      let requisitionCancelled = false;
      if (remainingActive.recordset[0].cnt === 0) {
        await new sql.Request(transaction).input('reqId', sql.Int, item.RequisitionId).query(`
          UPDATE dbo.Requisitions SET Status = 'Cancelled', UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = @reqId AND Status NOT IN ('Reconciled', 'Approved')
        `);
        requisitionCancelled = true;
      }

      // Cancelling can be what finally clears the last hold on this RFQ —
      // same "flip owning requisitions to Approved" step the main
      // evaluation POST / runs when fullyResolved, so this doesn't strand
      // sibling requisitions at EvaluationPending. Explicitly skips
      // anything already Cancelled/Reconciled (incl. the one just
      // cancelled above).
      const remainingHolds = await new sql.Request(transaction).input('rfqId', sql.Int, item.RFQId).query(
        'SELECT COUNT(*) AS c FROM dbo.RFQItemHolds WHERE RFQId = @rfqId'
      );
      if (remainingHolds.recordset[0].c === 0) {
        await new sql.Request(transaction).input('rfqId', sql.Int, item.RFQId).query(`
          UPDATE r
          SET Status = 'Approved', UpdatedAt = GETUTCDATE()
          FROM dbo.Requisitions r
          WHERE EXISTS (
            SELECT 1 FROM dbo.RequisitionItems ri2 WHERE ri2.RequisitionId = r.RequisitionId AND ri2.RFQId = @rfqId
          ) AND r.Status NOT IN ('Cancelled', 'Reconciled')
        `);
      }

      await transaction.commit();
      res.json({ ok: true, requisitionCancelled });
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

// ── GET /api/procurement/evaluation/awarded ───────────────────────────────
// Procurement's LPO queue. Returns TWO kinds of rows, merged:
//   - "full"  → legacy single-winner evaluations (pre-020), keyed by RFQId
//   - "split" → per-item evaluations, one row PER (RFQId, SupplierId) pair
//               that still needs an LPO raised in Busy for that supplier
router.get('/awarded', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const pool = await getPool();

    const legacyResult = await pool.request().query(`
      SELECT
        ev.QuoteEvaluationId, ev.ApprovedAt, ev.Notes AS EvalNotes,
        rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt,
        STRING_AGG(r.BusyOrdNo, ', ') AS BusyOrdNo,
        MIN(r.BusyDate) AS BusyDate,
        STRING_AGG(r.MatCenter, ', ') AS MatCenter,
        STRING_AGG(r.Warehouse, ', ') AS Warehouse,
        q.QuotationId, q.TotalAmount, q.ValidUntil, q.PaymentTerms, q.DeliveryDays, q.Notes AS QuoteNotes,
        s.SupplierId, s.SupplierName, s.SupplierCode, s.Email, s.Phone, s.WhatsApp,
        dir.FullName AS DirectorName
      FROM dbo.QuoteEvaluations ev
      JOIN dbo.RFQs rfq            ON rfq.RFQId = ev.RFQId
      JOIN dbo.Requisitions r      ON r.RFQId = rfq.RFQId
      JOIN dbo.Quotations q        ON q.QuotationId = ev.WinningQuotationId
      JOIN dbo.Suppliers s         ON s.SupplierId = q.SupplierId
      LEFT JOIN dbo.Users dir      ON dir.UserId = ev.DirectorUserId
      LEFT JOIN dbo.LPOReconciliation rec ON rec.RFQId = rfq.RFQId
      WHERE ev.WinningQuotationId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM dbo.QuoteEvaluationItems qei WHERE qei.QuoteEvaluationId = ev.QuoteEvaluationId)
        AND rec.LPOReconciliationId IS NULL
      GROUP BY ev.QuoteEvaluationId, ev.ApprovedAt, ev.Notes,
               rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt,
               q.QuotationId, q.TotalAmount, q.ValidUntil, q.PaymentTerms, q.DeliveryDays, q.Notes,
               s.SupplierId, s.SupplierName, s.SupplierCode, s.Email, s.Phone, s.WhatsApp,
               dir.FullName
    `);

    // NOTE: Requisitions are aggregated via CROSS APPLY (one row per RFQ)
    // rather than a direct JOIN — joining dbo.Requisitions directly would
    // fan out each dbo.QuoteEvaluationItems row once per linked
    // requisition on bundled/multi-requisition RFQs, silently multiplying
    // SUM(qei.UnitPrice * qei.Qty) below (e.g. tripling TotalAmount for a
    // 3-requisition bundle). rec.SupplierId requires
    // add-lpo-reconciliation-supplier.sql to have been run — without it
    // this join fails with "Invalid column name 'SupplierId'", which
    // previously broke this ENTIRE endpoint (including legacy/full
    // awards) any time a split-awarded RFQ existed.
    const splitResult = await pool.request().query(`
      SELECT
        ev.QuoteEvaluationId, ev.ApprovedAt, ev.Notes AS EvalNotes,
        rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt,
        reqAgg.BusyOrdNo, reqAgg.BusyDate, reqAgg.MatCenter, reqAgg.Warehouse,
        s.SupplierId, s.SupplierName, s.SupplierCode, s.Email, s.Phone, s.WhatsApp,
        dir.FullName AS DirectorName,
        SUM(qei.UnitPrice * qei.Qty) AS TotalAmount
      FROM dbo.QuoteEvaluations ev
      JOIN dbo.RFQs rfq ON rfq.RFQId = ev.RFQId
      CROSS APPLY (
        -- Requisitions that actually own an item in THIS RFQ (per
        -- RequisitionItems.RFQId) — Requisitions.RFQId alone is now just
        -- "most recent RFQ" and could miss/mismatch a split requisition.
        SELECT STRING_AGG(r.BusyOrdNo, ', ') AS BusyOrdNo,
               MIN(r.BusyDate)               AS BusyDate,
               STRING_AGG(r.MatCenter, ', ')  AS MatCenter,
               STRING_AGG(r.Warehouse, ', ')  AS Warehouse
        FROM dbo.Requisitions r
        WHERE r.RequisitionId IN (
          SELECT DISTINCT ri2.RequisitionId FROM dbo.RequisitionItems ri2 WHERE ri2.RFQId = rfq.RFQId
        )
      ) reqAgg
      JOIN dbo.QuoteEvaluationItems qei ON qei.QuoteEvaluationId = ev.QuoteEvaluationId
      JOIN dbo.Suppliers s              ON s.SupplierId = qei.SupplierId
      LEFT JOIN dbo.Users dir           ON dir.UserId = ev.DirectorUserId
      LEFT JOIN dbo.LPOReconciliation rec
        ON rec.RFQId = rfq.RFQId AND rec.SupplierId = s.SupplierId
      WHERE rec.LPOReconciliationId IS NULL
      GROUP BY ev.QuoteEvaluationId, ev.ApprovedAt, ev.Notes,
               rfq.RFQId, rfq.RFQNumber, rfq.DeadlineAt,
               reqAgg.BusyOrdNo, reqAgg.BusyDate, reqAgg.MatCenter, reqAgg.Warehouse,
               s.SupplierId, s.SupplierName, s.SupplierCode, s.Email, s.Phone, s.WhatsApp,
               dir.FullName
    `);

    const legacy = legacyResult.recordset;
    const split = splitResult.recordset;
    if (legacy.length === 0 && split.length === 0) return res.json([]);

    // Legacy rows: pull the full quotation's line items (as before)
    let legacyLinesByQuote = {};
    if (legacy.length > 0) {
      const quotationIds = legacy.map((a) => a.QuotationId);
      const placeholders = quotationIds.map((_, i) => `@q${i}`).join(',');
      const linesRequest = pool.request();
      quotationIds.forEach((id, i) => linesRequest.input(`q${i}`, sql.Int, id));
      const linesResult = await linesRequest.query(`
        SELECT li.QuotationId, li.RequisitionItemId, li.UnitPrice, li.Qty,
               li.Brand, li.QualityDescription, li.Notes, li.PhotoUrl, li.IsVatInclusive,
               li.AlternateUnitPrices, li.IsNotAvailable,
               ri.ItemName, ri.Category
        FROM dbo.QuotationLineItems li
        JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = li.RequisitionItemId
        WHERE li.QuotationId IN (${placeholders})
        ORDER BY ri.ItemName
      `);
      for (const line of linesResult.recordset) {
        (legacyLinesByQuote[line.QuotationId] ||= []).push(line);
      }
    }

    // Split rows: pull ONLY the items this particular supplier actually won
    let splitItemsByEvalSupplier = {};
    if (split.length > 0) {
      const evalIds = [...new Set(split.map((s) => s.QuoteEvaluationId))];
      const placeholders = evalIds.map((_, i) => `@e${i}`).join(',');
      const itemsRequest = pool.request();
      evalIds.forEach((id, i) => itemsRequest.input(`e${i}`, sql.Int, id));
      const itemsResult = await itemsRequest.query(`
        SELECT qei.QuoteEvaluationId, qei.SupplierId, qei.UnitPrice, qei.Qty,
               li.Brand, li.QualityDescription, li.Notes, li.PhotoUrl, li.IsVatInclusive,
               li.AlternateUnitPrices, li.IsNotAvailable,
               ri.ItemName, ri.Category
        FROM dbo.QuoteEvaluationItems qei
        JOIN dbo.QuotationLineItems li ON li.QuotationLineItemId = qei.QuotationLineItemId
        JOIN dbo.RequisitionItems ri   ON ri.RequisitionItemId = qei.RequisitionItemId
        WHERE qei.QuoteEvaluationId IN (${placeholders})
        ORDER BY ri.ItemName
      `);
      for (const row of itemsResult.recordset) {
        const key = `${row.QuoteEvaluationId}:${row.SupplierId}`;
        (splitItemsByEvalSupplier[key] ||= []).push(row);
      }
    }

    const legacyOut = legacy.map((a) => ({
      ...a,
      awardType: 'full',
      lineItems: legacyLinesByQuote[a.QuotationId] || [],
    }));
    const splitOut = split.map((a) => ({
      ...a,
      awardType: 'split',
      lineItems: splitItemsByEvalSupplier[`${a.QuoteEvaluationId}:${a.SupplierId}`] || [],
    }));

    const result = [...legacyOut, ...splitOut].sort(
      (x, y) => new Date(y.ApprovedAt) - new Date(x.ApprovedAt)
    );
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/evaluation/by-rfq/:rfqId ─────────────────────────
router.get('/by-rfq/:rfqId', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const rfqId = parseInt(req.params.rfqId, 10);
    const pool  = await getPool();

    const rfqResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT rfq.*,
             ev.QuoteEvaluationId, ev.WinningQuotationId, ev.ApprovedAt,
             ev.Notes AS EvalNotes, u.FullName AS DirectorName
      FROM dbo.RFQs rfq
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.RFQId = rfq.RFQId
      LEFT JOIN dbo.Users u ON u.UserId = ev.DirectorUserId
      WHERE rfq.RFQId = @id
    `);
    if (rfqResult.recordset.length === 0) {
      return res.status(404).json({ error: 'RFQ not found' });
    }
    const rfq = rfqResult.recordset[0];

    // Requisitions derived via the items that actually belong to this RFQ
    // (RequisitionItems.RFQId), not Requisitions.RFQId — a requisition
    // split across two RFQs must only show up for the one that actually
    // has items in it.
    const requisitionsResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT DISTINCT r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter, r.Status
      FROM dbo.Requisitions r
      JOIN dbo.RequisitionItems ri ON ri.RequisitionId = r.RequisitionId
      WHERE ri.RFQId = @id
      ORDER BY r.BusyOrdNo
    `);
    const requisitions = requisitionsResult.recordset;
    rfq.requisitions  = requisitions;
    rfq.BusyOrdNo     = requisitions.map((r) => r.BusyOrdNo).join(', ');
    rfq.BusyDate      = requisitions[0]?.BusyDate || null;
    rfq.MatCenter     = [...new Set(requisitions.map((r) => r.MatCenter).filter(Boolean))].join(', ') || null;
    rfq.Warehouse     = [...new Set(requisitions.map((r) => r.Warehouse).filter(Boolean))].join(', ') || null;
    rfq.RequisitionId = requisitions[0]?.RequisitionId || null;

    const quotesResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT q.QuotationId, q.SupplierId, q.SubmittedAt, q.SubmissionChannel,
             q.ValidUntil, q.PaymentTerms, q.DeliveryDays, q.TotalAmount, q.Notes,
             s.SupplierName, s.SupplierCode
      FROM dbo.Quotations q
      JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
      WHERE q.RFQId = @id AND q.IsWithdrawn = 0
      ORDER BY q.TotalAmount ASC
    `);

    const linesResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT li.QuotationLineItemId, li.QuotationId, li.RequisitionItemId,
             li.UnitPrice, li.Qty, li.LineTotal, li.Brand, li.QualityDescription,
             li.PhotoUrl, li.IsVatInclusive, li.AlternateUnitPrices, li.IsNotAvailable,
             ri.ItemName, ri.ItemCode, ri.Qty AS RequiredQty, ri.Category
      FROM dbo.QuotationLineItems li
      JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = li.RequisitionItemId
      JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId
      WHERE q.RFQId = @id AND q.IsWithdrawn = 0
    `);

    const itemNames = [...new Set(linesResult.recordset.map((l) => l.ItemName))];

    const benchmarks = {};
    try {
      const erpPool = await getErpPool();
      for (const itemName of itemNames) {
        const bResult = await erpPool.request()
          .input('itemName', erpSql.NVarChar(40), itemName.substring(0, 40))
          .query(`
            SELECT
              COUNT(*)                  AS PurchaseCount,
              AVG(CAST(Price AS FLOAT)) AS AvgUnitPrice,
              MIN(Price)                AS MinUnitPrice,
              MAX(Price)                AS MaxUnitPrice,
              MAX([Date])               AS LastPurchaseDate
            FROM dbo.PurOrder
            WHERE LTRIM(RTRIM([itemName])) = LTRIM(RTRIM(@itemName))
              AND [Date] >= DATEADD(year, -1, GETDATE())
              AND Price > 0
          `);
        if (bResult.recordset[0]?.PurchaseCount > 0) {
          benchmarks[itemName] = bResult.recordset[0];
        }
      }
    } catch (erpErr) {
      benchmarks._erpError = 'ERP benchmark unavailable';
    }

    const linesByQuote = {};
    for (const line of linesResult.recordset) {
      if (!linesByQuote[line.QuotationId]) linesByQuote[line.QuotationId] = [];
      const bench = benchmarks[line.ItemName];
      linesByQuote[line.QuotationId].push({
        ...line,
        benchmark: bench || null,
        aboveBenchmark: bench
          ? Number(line.UnitPrice) > Number(bench.AvgUnitPrice) * 1.1
          : null,
      });
    }

    const quotations = quotesResult.recordset.map((q, rank) => ({
      ...q,
      rank: rank + 1,
      lineItems: linesByQuote[q.QuotationId] || [],
    }));

    // Full master list of every RequisitionItem actually linked to THIS
    // RFQ (RequisitionItems.RFQId = @id) — sent to the frontend so it can
    // always render one row per item regardless of who has (or hasn't)
    // quoted on it. Previously the Director Evaluation page derived its
    // item list purely from the UNION of submitted quotations' line
    // items, so any item that no supplier had quoted yet (or that a
    // given supplier skipped/left unpriced) simply never appeared in the
    // table at all — looking exactly like "some items are missing" once
    // a supplier's partial quote came back. Filtered by RFQId directly
    // (not "every item on the linked requisitions") — a requisition can
    // have OTHER items sent in a separate RFQ, which must never leak
    // into this one's award matrix. Ops-rejected items are excluded too,
    // though in practice they'd never have an RFQId set in the first
    // place (rfq.routes.js never links them).
    const allItemsResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty AS RequiredQty, ri.Category
      FROM dbo.RequisitionItems ri
      LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
      WHERE ri.RFQId = @id AND ISNULL(ia.Decision, 'Approved') = 'Approved'
      ORDER BY ri.ItemName
    `);
    const allRequisitionItems = allItemsResult.recordset;
    const requiredItemCount = allRequisitionItems.length;

    const weightOverrides = {};
    for (const key of ['price', 'benchmark', 'delivery', 'payment', 'completeness']) {
      const qp = req.query[`${key}Weight`];
      if (qp !== undefined && !isNaN(parseFloat(qp))) weightOverrides[key] = parseFloat(qp);
    }
    const scoring = scoreQuotations(quotations, requiredItemCount, weightOverrides);

    // Per-item award state (migration 020). Empty array for RFQs not yet
    // evaluated, and for legacy pre-020 evaluations that only set
    // WinningQuotationId — those still render via that field, unchanged.
    let awardedItems = [];
    if (rfq.QuoteEvaluationId) {
      const itemsResult = await pool.request().input('evalId', sql.Int, rfq.QuoteEvaluationId).query(`
        SELECT qei.RequisitionItemId, qei.QuotationLineItemId, qei.SupplierId,
               qei.UnitPrice, qei.Qty, s.SupplierName
        FROM dbo.QuoteEvaluationItems qei
        JOIN dbo.Suppliers s ON s.SupplierId = qei.SupplierId
        WHERE qei.QuoteEvaluationId = @evalId
      `);
      awardedItems = itemsResult.recordset;
    }
    // Items the Director has put on hold — still needs a winner, but
    // isn't blocking approval of the rest of this RFQ. A held item stays
    // pickable in the UI even after the RFQ has an evaluation header.
    const holdsResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT h.RequisitionItemId, h.Reason, h.HeldAt, u.FullName AS HeldByName
      FROM dbo.RFQItemHolds h
      LEFT JOIN dbo.Users u ON u.UserId = h.HeldByUserId
      WHERE h.RFQId = @id
    `);
    rfq.heldItems = holdsResult.recordset;

    rfq.awardedItems = awardedItems;
    rfq.isSplitAward = awardedItems.length > 0;
    rfq.isEvaluated  = !!rfq.QuoteEvaluationId;
    // Fully locked/read-only only once evaluated AND every held item has
    // since been resolved — while holds remain, the Director can keep
    // coming back to award them without re-opening the whole RFQ.
    rfq.isFullyResolved = rfq.isEvaluated && rfq.heldItems.length === 0;
    rfq.allItems     = allRequisitionItems;

    // Every supplier this RFQ was dispatched to, and whether they've
    // actually submitted a (non-withdrawn) quotation yet — so the
    // Director can see who's still outstanding before deciding whether
    // to award now or wait for them.
    const dispatchesResult = await pool.request().input('id', sql.Int, rfqId).query(`
      SELECT d.RFQDispatchId, d.SentAt, d.TokenExpiresAt, d.Channel,
             s.SupplierId, s.SupplierName,
             q.QuotationId
      FROM dbo.RFQDispatches d
      JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
      LEFT JOIN dbo.Quotations q ON q.RFQDispatchId = d.RFQDispatchId AND q.IsWithdrawn = 0
      WHERE d.RFQId = @id
      ORDER BY s.SupplierName
    `);
    rfq.nonResponders = dispatchesResult.recordset
      .filter((d) => !d.QuotationId)
      .map((d) => ({
        SupplierId:     d.SupplierId,
        SupplierName:   d.SupplierName,
        SentAt:         d.SentAt,
        TokenExpiresAt: d.TokenExpiresAt,
        Channel:        d.Channel,
        isExpired:      !!(d.TokenExpiresAt && new Date(d.TokenExpiresAt) < new Date()),
      }));

    res.json({ ...rfq, quotations, benchmarks, scoring });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/evaluation ───────────────────────────────────────
// Director approves per-item winners. Body: { rfqId, notes,
//   awards: [ { requisitionItemId, quotationLineItemId } ],
//   holds:  [ { requisitionItemId, reason } ]  (optional)
// }
// UnitPrice/Qty/SupplierId are NEVER trusted from the client — they're
// looked up server-side from the QuotationLineItemId.
//
// Held items (2026-08-21): an item with a `holds` entry instead of an
// award is recorded in dbo.RFQItemHolds and skipped — it does NOT block
// approval of the rest of the RFQ. This makes evaluation an INCREMENTAL
// process per RFQ rather than strictly once-only: the first submission
// creates the dbo.QuoteEvaluations header (even if some items are held),
// and a later submission for the same RFQ is allowed as long as items
// still on hold remain — it reuses the same header and only needs to
// cover those still-undecided items (already-awarded ones are immutable
// and excluded from what's required this time). Requisitions only flip
// to Status = 'Approved' once ZERO holds remain for the RFQ.
router.post('/', authenticate, authorize('Admin', 'Director'), async (req, res, next) => {
  try {
    const { rfqId, notes, awards, holds } = req.body;
    const rfqIdInt = parseInt(rfqId, 10);
    const awardsArr = Array.isArray(awards) ? awards : [];
    const holdsArr = Array.isArray(holds) ? holds : [];
    if (!rfqIdInt || (awardsArr.length === 0 && holdsArr.length === 0)) {
      return res.status(400).json({ error: 'rfqId and at least one award or hold are required' });
    }

    const pool = await getPool();

    const existingEval = await pool.request()
      .input('rfqId', sql.Int, rfqIdInt)
      .query('SELECT QuoteEvaluationId FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');
    const existingEvalId = existingEval.recordset[0]?.QuoteEvaluationId || null;

    // Items already awarded in a prior submission on this RFQ — immutable,
    // and excluded from what this submission needs to cover.
    let alreadyAwardedIds = new Set();
    if (existingEvalId) {
      const awardedResult = await pool.request().input('evalId', sql.Int, existingEvalId).query(
        'SELECT RequisitionItemId FROM dbo.QuoteEvaluationItems WHERE QuoteEvaluationId = @evalId'
      );
      alreadyAwardedIds = new Set(awardedResult.recordset.map((r) => r.RequisitionItemId));
    }

    // Items currently on hold from a prior submission — this call is
    // expected to resolve some/all of them (via `awards`), or re-affirm
    // the rest (via `holds`).
    const currentHoldsResult = await pool.request().input('rfqId', sql.Int, rfqIdInt).query(
      'SELECT RequisitionItemId FROM dbo.RFQItemHolds WHERE RFQId = @rfqId'
    );
    const currentHoldIds = new Set(currentHoldsResult.recordset.map((r) => r.RequisitionItemId));

    if (existingEvalId && currentHoldIds.size === 0) {
      return res.status(409).json({ error: 'This RFQ has already been fully evaluated' });
    }

    // Every RequisitionItem actually linked to THIS RFQ (RequisitionItems.RFQId)
    // must be accounted for by an award or a hold — except items already
    // awarded in a prior submission, which are excluded here (immutable).
    // Filtered by RFQId directly, not "every item on the linked
    // requisitions" — a requisition can have other items sent in a
    // separate RFQ. Also excludes items the Ops Manager rejected pre-RFQ.
    const reqItemsResult = await pool.request().input('rfqId', sql.Int, rfqIdInt).query(`
      SELECT ri.RequisitionItemId
      FROM dbo.RequisitionItems ri
      LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
      WHERE ri.RFQId = @rfqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
    `);
    const requiredItemIds = new Set(
      reqItemsResult.recordset
        .map((r) => r.RequisitionItemId)
        .filter((id) => !alreadyAwardedIds.has(id))
    );
    if (requiredItemIds.size === 0) {
      return res.status(400).json({ error: 'RFQ has no requisition items left to decide' });
    }

    const seen = new Set();
    for (const a of awardsArr) {
      const reqItemId = parseInt(a?.requisitionItemId, 10);
      const lineItemId = parseInt(a?.quotationLineItemId, 10);
      if (!reqItemId || !lineItemId) {
        return res.status(400).json({ error: 'Each award needs a requisitionItemId and quotationLineItemId' });
      }
      if (seen.has(reqItemId)) {
        return res.status(400).json({ error: `Item ${reqItemId} was decided more than once` });
      }
      seen.add(reqItemId);
    }
    for (const h of holdsArr) {
      const reqItemId = parseInt(h?.requisitionItemId, 10);
      if (!reqItemId) {
        return res.status(400).json({ error: 'Each hold needs a requisitionItemId' });
      }
      if (seen.has(reqItemId)) {
        return res.status(400).json({ error: `Item ${reqItemId} was decided more than once` });
      }
      seen.add(reqItemId);
    }
    const missing = [...requiredItemIds].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Every item needs a winner or a hold before approval. Missing item id(s): ${missing.join(', ')}` });
    }

    // Server-side lookup + validation of each awarded line item
    let lineById = new Map();
    if (awardsArr.length > 0) {
      const lineItemIds = awardsArr.map((a) => parseInt(a.quotationLineItemId, 10));
      const placeholders = lineItemIds.map((_, i) => `@li${i}`).join(',');
      const lineLookupReq = pool.request();
      lineItemIds.forEach((id, i) => lineLookupReq.input(`li${i}`, sql.Int, id));
      const lineLookup = await lineLookupReq.query(`
        SELECT li.QuotationLineItemId, li.RequisitionItemId, li.UnitPrice, li.Qty,
               q.SupplierId, q.QuotationId, q.RFQId, q.IsWithdrawn
        FROM dbo.QuotationLineItems li
        JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId
        WHERE li.QuotationLineItemId IN (${placeholders})
      `);
      lineById = new Map(lineLookup.recordset.map((l) => [l.QuotationLineItemId, l]));

      for (const a of awardsArr) {
        const reqItemId = parseInt(a.requisitionItemId, 10);
        const line = lineById.get(parseInt(a.quotationLineItemId, 10));
        if (!line) return res.status(400).json({ error: `Quotation line item ${a.quotationLineItemId} not found` });
        if (line.RFQId !== rfqIdInt) return res.status(400).json({ error: `Quotation line item ${a.quotationLineItemId} does not belong to this RFQ` });
        if (line.IsWithdrawn) return res.status(400).json({ error: `Quotation line item ${a.quotationLineItemId} belongs to a withdrawn quotation` });
        if (line.RequisitionItemId !== reqItemId) return res.status(400).json({ error: `Quotation line item ${a.quotationLineItemId} does not match requisition item ${reqItemId}` });
      }
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      let evaluation;
      if (existingEvalId) {
        const evalResult = await new sql.Request(transaction)
          .input('evalId', sql.Int, existingEvalId)
          .input('Notes', sql.NVarChar(1000), notes || null)
          .query(`
            UPDATE dbo.QuoteEvaluations
            SET Notes = COALESCE(@Notes, Notes)
            OUTPUT INSERTED.*
            WHERE QuoteEvaluationId = @evalId
          `);
        evaluation = evalResult.recordset[0];
      } else {
        const evalResult = await new sql.Request(transaction)
          .input('RFQId', sql.Int, rfqIdInt)
          .input('DirectorUserId', sql.Int, req.user.userId)
          .input('Notes', sql.NVarChar(1000), notes || null)
          .query(`
            INSERT INTO dbo.QuoteEvaluations (RFQId, DirectorUserId, Notes)
            OUTPUT INSERTED.*
            VALUES (@RFQId, @DirectorUserId, @Notes)
          `);
        evaluation = evalResult.recordset[0];
      }

      if (awardsArr.length > 0) {
        const itemsPayload = awardsArr.map((a) => {
          const line = lineById.get(parseInt(a.quotationLineItemId, 10));
          return {
            RequisitionItemId: line.RequisitionItemId,
            QuotationLineItemId: line.QuotationLineItemId,
            SupplierId: line.SupplierId,
            UnitPrice: line.UnitPrice,
            Qty: line.Qty,
          };
        });

        await new sql.Request(transaction)
          .input('evalId', sql.Int, evaluation.QuoteEvaluationId)
          .input('itemsJson', sql.NVarChar(sql.MAX), JSON.stringify(itemsPayload))
          .query(`
            INSERT INTO dbo.QuoteEvaluationItems
              (QuoteEvaluationId, RequisitionItemId, QuotationLineItemId, SupplierId, UnitPrice, Qty)
            SELECT @evalId, j.RequisitionItemId, j.QuotationLineItemId, j.SupplierId, j.UnitPrice, j.Qty
            FROM OPENJSON(@itemsJson) WITH (
              RequisitionItemId    INT           '$.RequisitionItemId',
              QuotationLineItemId  INT           '$.QuotationLineItemId',
              SupplierId           INT           '$.SupplierId',
              UnitPrice            DECIMAL(12,4) '$.UnitPrice',
              Qty                  DECIMAL(12,2) '$.Qty'
            ) j
          `);

        // Any item just awarded that was previously held is now resolved.
        const awardedIdPlaceholders = awardsArr.map((_, i) => `@a${i}`).join(',');
        const clearHoldsReq = new sql.Request(transaction).input('rfqId', sql.Int, rfqIdInt);
        awardsArr.forEach((a, i) => clearHoldsReq.input(`a${i}`, sql.Int, parseInt(a.requisitionItemId, 10)));
        await clearHoldsReq.query(`
          DELETE FROM dbo.RFQItemHolds WHERE RFQId = @rfqId AND RequisitionItemId IN (${awardedIdPlaceholders})
        `);
      }

      for (const h of holdsArr) {
        const reqItemId = parseInt(h.requisitionItemId, 10);
        // Upsert: clear any prior hold row for this item, then insert fresh
        // (keeps the reason/timestamp current if the Director re-holds it).
        await new sql.Request(transaction)
          .input('rfqId', sql.Int, rfqIdInt)
          .input('itemId', sql.Int, reqItemId)
          .query('DELETE FROM dbo.RFQItemHolds WHERE RFQId = @rfqId AND RequisitionItemId = @itemId');
        await new sql.Request(transaction)
          .input('rfqId', sql.Int, rfqIdInt)
          .input('itemId', sql.Int, reqItemId)
          .input('reason', sql.NVarChar(500), h.reason || null)
          .input('userId', sql.Int, req.user.userId)
          .query(`
            INSERT INTO dbo.RFQItemHolds (RFQId, RequisitionItemId, Reason, HeldByUserId)
            VALUES (@rfqId, @itemId, @reason, @userId)
          `);
      }

      const remainingHoldsResult = await new sql.Request(transaction)
        .input('rfqId', sql.Int, rfqIdInt)
        .query('SELECT COUNT(*) AS c FROM dbo.RFQItemHolds WHERE RFQId = @rfqId');
      const fullyResolved = remainingHoldsResult.recordset[0].c === 0;

      if (fullyResolved) {
        // Matched via RequisitionItems.RFQId (which requisitions actually
        // OWN an item in this RFQ), not Requisitions.RFQId — the latter
        // is just "most recent RFQ" and could miss a requisition whose
        // items here came from an earlier RFQ than its current pointer.
        await new sql.Request(transaction).input('rfqId', sql.Int, rfqIdInt).query(`
          UPDATE r
          SET Status = 'Approved', UpdatedAt = GETUTCDATE()
          FROM dbo.Requisitions r
          WHERE EXISTS (
            SELECT 1 FROM dbo.RequisitionItems ri WHERE ri.RequisitionId = r.RequisitionId AND ri.RFQId = @rfqId
          )
        `);
      }

      await transaction.commit();
      res.status(existingEvalId ? 200 : 201).json({
        ...evaluation,
        awardedCount: awardsArr.length,
        heldCount: holdsArr.length,
        fullyResolved,
      });
    } catch (trxErr) {
      await transaction.rollback();
      throw trxErr;
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/procurement/evaluation/:rfqId ─────────────────────────────
// Cascade-deletes QuoteEvaluationItems automatically (FK ON DELETE CASCADE,
// migration 020). Blocked if ANY supplier's LPO is already reconciled.
router.delete('/:rfqId', authenticate, authorize('Admin', 'Director'), async (req, res, next) => {
  try {
    const rfqId = parseInt(req.params.rfqId, 10);
    if (!rfqId) return res.status(400).json({ error: 'Invalid rfqId' });

    const pool = await getPool();

    const evalCheck = await pool.request()
      .input('rfqId', sql.Int, rfqId)
      .query('SELECT QuoteEvaluationId FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');
    if (evalCheck.recordset.length === 0) {
      return res.status(404).json({ error: 'No evaluation found for this RFQ' });
    }

    const recCheck = await pool.request()
      .input('rfqId', sql.Int, rfqId)
      .query('SELECT LPOReconciliationId FROM dbo.LPOReconciliation WHERE RFQId = @rfqId');
    if (recCheck.recordset.length > 0) {
      return res.status(409).json({
        error: 'An LPO has already been reconciled for this RFQ in Busy (at least one supplier). Undoing the approval now would leave Busy and this system disagreeing about the winner(s).',
      });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input('rfqId', sql.Int, rfqId)
        .query('DELETE FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');

      // Clear any lingering item holds too — undoing the whole evaluation
      // means starting fresh, not leaving stale holds behind.
      await new sql.Request(transaction)
        .input('rfqId', sql.Int, rfqId)
        .query('DELETE FROM dbo.RFQItemHolds WHERE RFQId = @rfqId');

      // Matched via RequisitionItems.RFQId, same reasoning as the
      // fullyResolved update in POST / above.
      await new sql.Request(transaction)
        .input('rfqId', sql.Int, rfqId)
        .input('status', sql.NVarChar(50), REVERT_STATUS)
        .query(`
          UPDATE r
          SET Status = @status, UpdatedAt = GETUTCDATE()
          FROM dbo.Requisitions r
          WHERE EXISTS (
            SELECT 1 FROM dbo.RequisitionItems ri WHERE ri.RequisitionId = r.RequisitionId AND ri.RFQId = @rfqId
          )
        `);

      await transaction.commit();
    } catch (trxErr) {
      await transaction.rollback();
      throw trxErr;
    }

    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;