/**
 * Public RFQ Token Routes — NO authentication required.
 * Suppliers click the tokenized link in their RFQ email to view items
 * and self-submit their quotation.
 *
 * Suppliers may revisit their link and RESUBMIT — the previous quotation
 * is withdrawn (IsWithdrawn = 1) and a new one is inserted, preserving
 * full history in dbo.Quotations for evaluation/audit purposes.
 *
 * Mounted at /rfq/:token  (outside /api/ prefix) — see index.js:
 *   const rfqPublicRoutes = require('./routes/rfq-public.routes');
 *   app.use('/rfq', rfqPublicLimiter, rfqPublicRoutes);
 * THIS is the file the server actually loads for that mount — a version
 * of this fix was previously saved under the wrong filename
 * (rfq-token.routes.js), which the server never requires, so the fix
 * never took effect. Confirmed via index.js's require path.
 *
 * Multi-requisition RFQs (2026-07-30): FIXED — this file previously
 * joined via rfq.RequisitionId (the old 1:1 column), which is NULL on
 * every RFQ created after migration 016. That silently broke every
 * supplier link for a bundled RFQ (404 on GET, and item-validation
 * failures on POST). Both routes now join via
 * dbo.Requisitions.RFQId = rfq.RFQId and aggregate across ALL linked
 * requisitions, not just one.
 *
 * Per-line VAT + photo (2026-08-18): Suppliers can now mark each quoted
 * line as VAT-inclusive or -exclusive, and optionally attach a photo of
 * that specific item (e.g. sample, packaging). Photo upload is a
 * separate endpoint (POST /:token/items/:requisitionItemId/photo) hit
 * as soon as the supplier picks a file — it returns a URL, which the
 * frontend then includes in the JSON submit payload. This keeps the
 * submit endpoint plain JSON instead of needing multipart handling for
 * the whole form.
 *
 * Per-supplier item assignment (2026-08-18): a dispatch can now carry
 * rows in dbo.RFQDispatchItems restricting which items THIS supplier is
 * shown — set at RFQ-creation time in rfq.routes.js. GET /:token and
 * POST /:token/submit both filter down to that subset when present.
 * A dispatch with no rows there (every dispatch created before this
 * feature, and any supplier procurement didn't restrict) still sees
 * every item across the linked requisitions — unchanged behavior.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { getPool, sql } = require('../db');
const { notifyDirectorsOfQuotation } = require('../services/rfq.service');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Photo upload config ─────────────────────────────────────────────────────
// Stored outside the repo, under a directory the server also serves
// statically (see index.js note at bottom of this file for the one line
// to add there). Filenames are randomized — never trust/use the
// original filename from a public, unauthenticated endpoint.
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'rfq-photos');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP or HEIC images are allowed'));
    }
    cb(null, true);
  },
});

// ── POST /rfq/:token/items/:requisitionItemId/photo ─────────────────────────
// Uploads a photo for a single quoted item. Validates the token and that
// the item actually belongs to a requisition linked to this RFQ, same as
// the main submit route, before accepting the file.
router.post('/:token/items/:requisitionItemId/photo', (req, res, next) => {
  upload.single('photo')(req, res, async (uploadErr) => {
    try {
      const token = req.params.token;
      if (!UUID_RE.test(token)) {
        return res.status(400).json({ error: 'Invalid token' });
      }

      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.message || 'Upload failed' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No photo received' });
      }

      const requisitionItemId = parseInt(req.params.requisitionItemId, 10);

      const pool = await getPool();

      const dispatchResult = await pool.request()
        .input('token', sql.UniqueIdentifier, token)
        .query(`
          SELECT d.RFQDispatchId, d.RFQId, d.TokenExpiresAt
          FROM dbo.RFQDispatches d
          WHERE d.Token = @token
        `);

      if (dispatchResult.recordset.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Invalid or expired link' });
      }
      const dispatch = dispatchResult.recordset[0];

      if (dispatch.TokenExpiresAt && new Date(dispatch.TokenExpiresAt) < new Date()) {
        fs.unlink(req.file.path, () => {});
        return res.status(410).json({ error: 'This quotation link has expired' });
      }

      // Confirm the item actually belongs to a requisition on this RFQ —
      // same guard as the main submit route, so a stray/guessed
      // requisitionItemId can't be used to attach a photo elsewhere.
      const itemCheck = await pool.request()
        .input('rfqId', sql.Int, dispatch.RFQId)
        .input('itemId', sql.Int, requisitionItemId)
        .query(`
          SELECT ri.RequisitionItemId
          FROM dbo.RequisitionItems ri
          JOIN dbo.Requisitions r ON r.RequisitionId = ri.RequisitionId
          WHERE r.RFQId = @rfqId AND ri.RequisitionItemId = @itemId
        `);

      if (itemCheck.recordset.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Item does not belong to this RFQ' });
      }

      // Publicly reachable URL — see index.js note below for the static
      // mount this depends on.
      const photoUrl = `/uploads/rfq-photos/${req.file.filename}`;
      res.status(201).json({ photoUrl });
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      next(err);
    }
  });
});

// ── GET /rfq/:token ───────────────────────────────────────────────────────────
// Returns RFQ details so the supplier can see what they need to quote on.
// If a quotation already exists for this dispatch, it's returned as
// `existingQuotation` so the frontend can pre-fill the form for editing.
router.get('/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!UUID_RE.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const pool = await getPool();

    // Dispatch + RFQ header only — requisitions are fetched separately
    // below since a bundled RFQ can now have several.
    const dispatchResult = await pool.request()
      .input('token', sql.UniqueIdentifier, token)
      .query(`
        SELECT d.RFQDispatchId, d.RFQId, d.SupplierId, d.TokenExpiresAt, d.Channel,
               s.SupplierName, s.Email,
               rfq.RFQNumber, rfq.DeadlineAt, rfq.Notes AS RFQNotes
        FROM dbo.RFQDispatches d
        JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
        JOIN dbo.RFQs rfq ON rfq.RFQId = d.RFQId
        WHERE d.Token = @token
      `);

    if (dispatchResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Quotation link not found or has expired' });
    }

    const dispatch = dispatchResult.recordset[0];

    // Check token expiry
    if (dispatch.TokenExpiresAt && new Date(dispatch.TokenExpiresAt) < new Date()) {
      return res.status(410).json({ error: 'This quotation link has expired. Please contact procurement.' });
    }

    // Items actually belonging to THIS RFQ (RequisitionItems.RFQId) —
    // excluding any item the Ops Manager rejected during per-item
    // requisition approval, so a supplier with no per-dispatch
    // restriction (the "sees everything" default) can never see or quote
    // on an item that was turned down before the RFQ was even created.
    // Per-item RFQ linkage: a requisition can have OTHER items sent in a
    // different RFQ, so items must be looked up by RFQId directly, not by
    // "every item on any requisition this RFQ touches."
    const itemsResult = await pool.request()
      .input('rfqId', sql.Int, dispatch.RFQId)
      .query(`
        SELECT ri.RequisitionItemId, ri.RequisitionId, ri.ItemName, ri.Qty, ri.Unit, ri.Category, ri.ReferencePhotoUrl,
               ri.PreferredBrand, ri.PreferredQuality
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        WHERE ri.RFQId = @rfqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
        ORDER BY ri.RequisitionItemId
      `);

    // Linked requisitions — derived from the items above (distinct
    // parents), not from Requisitions.RFQId, for the same reason.
    const requisitionIds = [...new Set(itemsResult.recordset.map((it) => it.RequisitionId))];
    if (requisitionIds.length === 0) {
      return res.status(404).json({ error: 'No requisitions linked to this RFQ' });
    }
    const reqIdPlaceholders = requisitionIds.map((_, i) => `@rq${i}`).join(',');
    const requisitionsReq = pool.request();
    requisitionIds.forEach((rid, i) => requisitionsReq.input(`rq${i}`, sql.Int, rid));
    const requisitionsResult = await requisitionsReq.query(`
      SELECT RequisitionId, BusyOrdNo, BusyDate, MatCenter, Warehouse
      FROM dbo.Requisitions
      WHERE RequisitionId IN (${reqIdPlaceholders})
      ORDER BY BusyOrdNo
    `);
    const requisitions = requisitionsResult.recordset;

    // Check whether a Director has already evaluated/approved this RFQ —
    // once that's happened, the link becomes read-only.
    const evalResult = await pool.request()
      .input('rfqId', sql.Int, dispatch.RFQId)
      .query('SELECT QuoteEvaluationId FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');
    const isEvaluated = evalResult.recordset.length > 0;

    // If procurement restricted this dispatch to specific items, only
    // show those. No rows here = show everything (unchanged behavior).
    const assignedResult = await pool.request()
      .input('dispatchId', sql.Int, dispatch.RFQDispatchId)
      .query('SELECT RequisitionItemId FROM dbo.RFQDispatchItems WHERE RFQDispatchId = @dispatchId');
    const assignedIds = new Set(assignedResult.recordset.map((r) => r.RequisitionItemId));
    const visibleItems = assignedIds.size > 0
      ? itemsResult.recordset.filter((it) => assignedIds.has(it.RequisitionItemId))
      : itemsResult.recordset;

    // Fetch the current (non-withdrawn) quotation, if any, plus its line items,
    // so the frontend can pre-fill the form for editing.
    let existingQuotation = null;
    const quoteResult = await pool.request()
      .input('dispatchId', sql.Int, dispatch.RFQDispatchId)
      .query(`
        SELECT TOP 1 QuotationId, ValidUntil, PaymentTerms, DeliveryDays, TotalAmount, Notes, SubmittedAt
        FROM dbo.Quotations
        WHERE RFQDispatchId = @dispatchId AND IsWithdrawn = 0
        ORDER BY QuotationId DESC
      `);

    if (quoteResult.recordset.length > 0) {
      const quote = quoteResult.recordset[0];
      const lineItemsResult = await pool.request()
        .input('quotationId', sql.Int, quote.QuotationId)
        .query(`
          SELECT RequisitionItemId, UnitPrice, Qty, Brand, QualityDescription, Notes,
                 IsVatInclusive, PhotoUrl, AlternateUnitPrices, IsNotAvailable
          FROM dbo.QuotationLineItems
          WHERE QuotationId = @quotationId
        `);

      existingQuotation = {
        quotationId:  quote.QuotationId,
        validUntil:   quote.ValidUntil,
        paymentTerms: quote.PaymentTerms,
        deliveryDays: quote.DeliveryDays,
        totalAmount:  quote.TotalAmount,
        notes:        quote.Notes,
        submittedAt:  quote.SubmittedAt,
        lineItems:    lineItemsResult.recordset,
      };
    }

    res.json({
      rfqNumber:      dispatch.RFQNumber,
      deadline:       dispatch.DeadlineAt,
      notes:          dispatch.RFQNotes,
      // Combined convenience fields across all linked requisitions
      busyOrdNo:      requisitions.map((r) => r.BusyOrdNo).join(', '),
      busyDate:       requisitions[0].BusyDate,
      matCenter:      [...new Set(requisitions.map((r) => r.MatCenter).filter(Boolean))].join(', ') || null,
      warehouse:      [...new Set(requisitions.map((r) => r.Warehouse).filter(Boolean))].join(', ') || null,
      requisitions,
      supplierName:   dispatch.SupplierName,
      rfqDispatchId:  dispatch.RFQDispatchId,
      hasExistingQuotation: existingQuotation !== null,
      existingQuotation,
      isEvaluated,
      items: visibleItems,
    });
  } catch (err) { next(err); }
});

// ── POST /rfq/:token/submit ───────────────────────────────────────────────────
// Supplier self-submits (or re-submits) a quotation via their token link.
// If a live quotation already exists for this dispatch, it is withdrawn
// (IsWithdrawn = 1) and the new one is inserted in its place — this keeps
// a full audit trail in dbo.Quotations rather than overwriting in place.
router.post('/:token/submit', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!UUID_RE.test(token)) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const { validUntil, paymentTerms, deliveryDays, notes, lineItems = [] } = req.body;

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'At least one line item with pricing is required' });
    }

    const pool = await getPool();

    // Validate token + expiry
    const dispatchResult = await pool.request()
      .input('token', sql.UniqueIdentifier, token)
      .query(`
        SELECT d.RFQDispatchId, d.RFQId, d.SupplierId, d.TokenExpiresAt,
               s.SupplierName, rfq.RFQNumber
        FROM dbo.RFQDispatches d
        JOIN dbo.Suppliers s ON s.SupplierId = d.SupplierId
        JOIN dbo.RFQs rfq ON rfq.RFQId = d.RFQId
        WHERE d.Token = @token
      `);

    if (dispatchResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired link' });
    }

    const dispatch = dispatchResult.recordset[0];
    if (dispatch.TokenExpiresAt && new Date(dispatch.TokenExpiresAt) < new Date()) {
      return res.status(410).json({ error: 'This quotation link has expired' });
    }

    // Once a Director has evaluated/approved this RFQ, it's locked —
    // no further edits, even from the previously-winning supplier, so the
    // approved quotation on record can't silently change out from under
    // reconciliation.
    const evalCheck = await pool.request()
      .input('rfqId', sql.Int, dispatch.RFQId)
      .query('SELECT QuoteEvaluationId FROM dbo.QuoteEvaluations WHERE RFQId = @rfqId');
    if (evalCheck.recordset.length > 0) {
      return res.status(410).json({ error: 'This RFQ has already been evaluated and is no longer open for changes' });
    }

    // Look up any live quotation for this dispatch — if present, it will be
    // withdrawn (not blocked) so the supplier can update their submission.
    const existingQuote = await pool.request()
      .input('dispatchId', sql.Int, dispatch.RFQDispatchId)
      .query(`SELECT QuotationId FROM dbo.Quotations WHERE RFQDispatchId = @dispatchId AND IsWithdrawn = 0`);
    const priorQuotationId = existingQuote.recordset[0]?.QuotationId || null;

    // Validate all submitted line items actually belong to THIS RFQ —
    // looked up directly via RequisitionItems.RFQId (per-item linkage), not
    // via "any item on any requisition this RFQ's requisitions happen to
    // have" — a requisition can have other items sent in a different RFQ,
    // which must never be quotable through this link.
    const validItems = await pool.request()
      .input('rfqId', sql.Int, dispatch.RFQId)
      .query(`
        SELECT ri.RequisitionItemId
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RequisitionItemApprovals ia ON ia.RequisitionItemId = ri.RequisitionItemId
        WHERE ri.RFQId = @rfqId AND ISNULL(ia.Decision, 'Approved') = 'Approved'
      `);
    let validItemIds = new Set(validItems.recordset.map((r) => r.RequisitionItemId));
    if (validItemIds.size === 0) {
      return res.status(404).json({ error: 'No items linked to this RFQ' });
    }

    // Narrow to this dispatch's assigned subset, if one was set — a
    // supplier restricted to specific items can't sneak pricing in for
    // an item they were never shown. No rows = no restriction (everyone
    // sees, and can quote on, everything — unchanged behavior).
    const assignedResult = await pool.request()
      .input('dispatchId', sql.Int, dispatch.RFQDispatchId)
      .query('SELECT RequisitionItemId FROM dbo.RFQDispatchItems WHERE RFQDispatchId = @dispatchId');
    if (assignedResult.recordset.length > 0) {
      const assignedIds = new Set(assignedResult.recordset.map((r) => r.RequisitionItemId));
      validItemIds = new Set([...validItemIds].filter((id) => assignedIds.has(id)));
    }

    // Photo URLs must have actually come from our own upload endpoint —
    // a supplier's browser could otherwise POST any string here.
    const isOwnUploadUrl = (u) => typeof u === 'string' && /^\/uploads\/rfq-photos\/[A-Za-z0-9-]+\.[a-z]+$/.test(u);

    for (const li of lineItems) {
      if (!validItemIds.has(parseInt(li.requisitionItemId, 10))) {
        return res.status(400).json({ error: `Invalid requisitionItemId: ${li.requisitionItemId}` });
      }
      if (parseFloat(li.unitPrice) < 0) {
        return res.status(400).json({ error: 'Unit prices must be non-negative' });
      }
      if (li.photoUrl && !isOwnUploadUrl(li.photoUrl)) {
        return res.status(400).json({ error: 'Invalid photo reference' });
      }
    }

    const totalAmount = lineItems.reduce(
      (sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseFloat(li.qty) || 0), 0
    );

    const { Transaction, Request: SqlRequest } = require('mssql');
    const tx = new Transaction(pool);
    await tx.begin();
    try {
      // Withdraw the prior quotation, if one exists, so it's excluded from
      // future joins/evaluation but stays in the table for history.
      if (priorQuotationId) {
        await new SqlRequest(tx)
          .input('id', sql.Int, priorQuotationId)
          .query(`UPDATE dbo.Quotations SET IsWithdrawn = 1 WHERE QuotationId = @id`);
      }

      const quoteResult = await new SqlRequest(tx)
        .input('RFQDispatchId',     sql.Int,            dispatch.RFQDispatchId)
        .input('RFQId',             sql.Int,            dispatch.RFQId)
        .input('SupplierId',        sql.Int,            dispatch.SupplierId)
        .input('SubmissionChannel', sql.VarChar(20),    'portal')
        .input('ValidUntil',        sql.Date,           validUntil || null)
        .input('PaymentTerms',      sql.NVarChar(200),  paymentTerms || null)
        .input('DeliveryDays',      sql.Int,            deliveryDays ? parseInt(deliveryDays, 10) : null)
        .input('TotalAmount',       sql.Decimal(14, 4), totalAmount)
        .input('Notes',             sql.NVarChar(1000), notes || null)
        .query(`
          INSERT INTO dbo.Quotations
            (RFQDispatchId, RFQId, SupplierId, SubmissionChannel,
             ValidUntil, PaymentTerms, DeliveryDays, TotalAmount, Notes)
          OUTPUT INSERTED.*
          VALUES
            (@RFQDispatchId, @RFQId, @SupplierId, @SubmissionChannel,
             @ValidUntil, @PaymentTerms, @DeliveryDays, @TotalAmount, @Notes)
        `);
      const quotation = quoteResult.recordset[0];

      for (const li of lineItems) {
        const unitPrice = li.unitPrice != null && !isNaN(parseFloat(li.unitPrice)) ? Math.max(0, parseFloat(li.unitPrice)) : 0;
        const qty       = li.qty != null && !isNaN(parseFloat(li.qty)) ? Math.max(0, parseFloat(li.qty)) : 0;
        await new SqlRequest(tx)
          .input('QuotationId',       sql.Int,            quotation.QuotationId)
          .input('RequisitionItemId', sql.Int,            parseInt(li.requisitionItemId, 10))
          .input('UnitPrice',         sql.Decimal(12, 4), unitPrice)
          .input('Qty',               sql.Decimal(12, 2), qty)
          .input('Brand',             sql.NVarChar(150),  li.brand || null)
          .input('QualityDescription', sql.NVarChar(500), li.qualityDescription || null)
          .input('Notes',             sql.NVarChar(500),  li.notes || null)
          .input('IsVatInclusive',    sql.Bit,            li.isVatInclusive ? 1 : 0)
          .input('PhotoUrl',          sql.NVarChar(500),  li.photoUrl || null)
          .input('AlternateUnitPrices', sql.NVarChar(500), li.alternatePrices || null)
          .input('IsNotAvailable',    sql.Bit,            li.isNotAvailable ? 1 : 0)
          .query(`
            INSERT INTO dbo.QuotationLineItems
              (QuotationId, RequisitionItemId, UnitPrice, Qty, Brand, QualityDescription, Notes,
               IsVatInclusive, PhotoUrl, AlternateUnitPrices, IsNotAvailable)
            VALUES
              (@QuotationId, @RequisitionItemId, @UnitPrice, @Qty, @Brand, @QualityDescription, @Notes,
               @IsVatInclusive, @PhotoUrl, @AlternateUnitPrices, @IsNotAvailable)
          `);
      }

      // Update status on every requisition that actually OWNS an item in
      // this RFQ (only advances it the first time — a resubmission on an
      // already-QuotesReceived requisition is a no-op here). Matched via
      // RequisitionItems.RFQId, not Requisitions.RFQId — the latter is
      // just "most recent RFQ" now and would miss a requisition whose
      // items here came from an EARLIER RFQ than its current pointer.
      await new SqlRequest(tx)
        .input('rfqId', sql.Int, dispatch.RFQId)
        .query(`
          UPDATE r
          SET Status = 'QuotesReceived', UpdatedAt = GETUTCDATE()
          FROM dbo.Requisitions r
          WHERE r.Status = 'RFQSent'
            AND EXISTS (
              SELECT 1 FROM dbo.RequisitionItems ri
              WHERE ri.RequisitionId = r.RequisitionId AND ri.RFQId = @rfqId
            )
        `);

      await tx.commit();

      // Notify the Director(s) — non-fatal. The supplier's submission has
      // already been committed; a failed notification email shouldn't turn
      // into an error response for them. Worst case, the RFQ still shows up
      // in the "Pending Evaluation" list next time a Director logs in.
      notifyDirectorsOfQuotation({
        rfqNumber:    dispatch.RFQNumber,
        rfqId:        dispatch.RFQId,
        supplierName: dispatch.SupplierName,
        totalAmount:  totalAmount,
        isUpdate:     priorQuotationId !== null,
      }).catch(() => {});

      res.status(201).json({
        ok: true,
        quotationId: quotation.QuotationId,
        updated: priorQuotationId !== null,
      });
    } catch (txErr) {
      await tx.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

module.exports = router;

/**
 * index.js change required (not included in this file):
 *
 * Add a static mount so uploaded photos are publicly reachable at the
 * /uploads/rfq-photos/... URLs this route returns:
 *
 *   app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
 *
 * Place it near your other app.use() calls, before the 404 handler.
 * Also run `npm install multer` if it isn't already a dependency.
 */