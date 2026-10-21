/**
 * Quotations Routes
 * Staff manually capture supplier quotes, or they arrive via the public token link.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');

const router = express.Router();
const PROC_ROLES = ['Admin', 'Procurement'];

// ── GET /api/procurement/quotations/by-rfq/:rfqId ────────────────────────────
router.get('/by-rfq/:rfqId', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const rfqId = parseInt(req.params.rfqId, 10);
    const pool = await getPool();

    const [quotesResult, linesResult] = await Promise.all([
      pool.request().input('rfqId', sql.Int, rfqId).query(`
        SELECT q.*, s.SupplierName, s.SupplierCode, s.Email, s.Phone
        FROM dbo.Quotations q
        JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
        WHERE q.RFQId = @rfqId
        ORDER BY q.TotalAmount ASC, q.SubmittedAt ASC
      `),
      pool.request().input('rfqId', sql.Int, rfqId).query(`
        SELECT li.QuotationLineItemId, li.QuotationId, li.RequisitionItemId,
               li.UnitPrice, li.Qty, li.LineTotal, li.Brand, li.QualityDescription,
               li.IsVatInclusive, li.PhotoUrl, li.Notes, li.AlternateUnitPrices, li.IsNotAvailable,
               ri.ItemName, ri.Qty AS RequiredQty, ri.Category
        FROM dbo.QuotationLineItems li
        JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = li.RequisitionItemId
        JOIN dbo.Quotations q ON q.QuotationId = li.QuotationId
        WHERE q.RFQId = @rfqId
      `),
    ]);

    const linesByQuote = {};
    for (const line of linesResult.recordset) {
      if (!linesByQuote[line.QuotationId]) linesByQuote[line.QuotationId] = [];
      linesByQuote[line.QuotationId].push(line);
    }
    const quotes = quotesResult.recordset.map((q) => ({
      ...q,
      lineItems: linesByQuote[q.QuotationId] || [],
    }));

    res.json(quotes);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/quotations ─────────────────────────────────────────
// Staff manually captures a phone / WhatsApp / email quote
router.post('/', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const {
      rfqDispatchId,
      submissionChannel = 'manual',
      validUntil,
      paymentTerms,
      deliveryDays,
      notes,
      lineItems = [], // [{ requisitionItemId, unitPrice, qty, brand, qualityDescription, isVatInclusive, notes, alternatePrices, isNotAvailable }]
    } = req.body;

    if (!rfqDispatchId || lineItems.length === 0) {
      return res.status(400).json({ error: 'rfqDispatchId and lineItems are required' });
    }

    const pool = await getPool();

    // Resolve RFQId and SupplierId from the dispatch
    const dispatchResult = await pool.request()
      .input('id', sql.Int, parseInt(rfqDispatchId, 10))
      .query(`SELECT RFQId, SupplierId FROM dbo.RFQDispatches WHERE RFQDispatchId = @id`);
    if (dispatchResult.recordset.length === 0) {
      return res.status(404).json({ error: 'RFQ dispatch not found' });
    }
    const { RFQId, SupplierId } = dispatchResult.recordset[0];

    // Compute total
    const totalAmount = lineItems.reduce(
      (sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseFloat(li.qty) || 0), 0
    );

    const tx = new (require('mssql').Transaction)(pool);
    await tx.begin();

    try {
      const quoteResult = await new (require('mssql').Request)(tx)
        .input('RFQDispatchId',     sql.Int,           parseInt(rfqDispatchId, 10))
        .input('RFQId',             sql.Int,           RFQId)
        .input('SupplierId',        sql.Int,           SupplierId)
        .input('SubmissionChannel', sql.VarChar(20),   submissionChannel)
        .input('ValidUntil',        sql.Date,          validUntil || null)
        .input('PaymentTerms',      sql.NVarChar(200), paymentTerms || null)
        .input('DeliveryDays',      sql.Int,           deliveryDays || null)
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
        // A line marked "not available" (procurement recording that this
        // supplier doesn't carry the item) has no real price/qty — store 0
        // rather than whatever was left in those fields, same convention
        // the supplier-facing portal submit uses.
        const unitPrice = li.isNotAvailable ? 0 : (parseFloat(li.unitPrice) || 0);
        const qty       = li.isNotAvailable ? 0 : (parseFloat(li.qty) || 0);
        await new (require('mssql').Request)(tx)
          .input('QuotationId',        sql.Int,           quotation.QuotationId)
          .input('RequisitionItemId',  sql.Int,           parseInt(li.requisitionItemId, 10))
          .input('UnitPrice',          sql.Decimal(12, 4), unitPrice)
          .input('Qty',                sql.Decimal(12, 2), qty)
          .input('Brand',              sql.NVarChar(150), li.isNotAvailable ? null : (li.brand || null))
          .input('QualityDescription', sql.NVarChar(500), li.isNotAvailable ? null : (li.qualityDescription || null))
          .input('IsVatInclusive',     sql.Bit,           li.isVatInclusive ? 1 : 0)
          .input('Notes',              sql.NVarChar(500), li.notes || null)
          .input('AlternateUnitPrices', sql.NVarChar(500), li.isNotAvailable ? null : (li.alternatePrices || null))
          .input('IsNotAvailable',     sql.Bit,           li.isNotAvailable ? 1 : 0)
          .query(`
            INSERT INTO dbo.QuotationLineItems
              (QuotationId, RequisitionItemId, UnitPrice, Qty, Brand, QualityDescription, IsVatInclusive, Notes, AlternateUnitPrices, IsNotAvailable)
            VALUES
              (@QuotationId, @RequisitionItemId, @UnitPrice, @Qty, @Brand, @QualityDescription, @IsVatInclusive, @Notes, @AlternateUnitPrices, @IsNotAvailable)
          `);
      }

      // Update requisition status to QuotesReceived
      await new (require('mssql').Request)(tx)
        .input('rfqId', sql.Int, RFQId)
        .query(`
          UPDATE dbo.Requisitions
          SET Status = 'QuotesReceived', UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = (SELECT RequisitionId FROM dbo.RFQs WHERE RFQId = @rfqId)
            AND Status = 'RFQSent'
        `);

      await tx.commit();
      res.status(201).json(quotation);
    } catch (txErr) {
      await tx.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

// ── PUT /api/procurement/quotations/:id ──────────────────────────────────────
// Lets Procurement amend a captured quote's prices/terms after the fact —
// e.g. a supplier negotiates a discount over the phone after already
// submitting. Safe at any point in the RFQ's life: an award, once made,
// snapshots its own UnitPrice/Qty into QuoteEvaluationItems (see
// add-quote-evaluation-items.sql) rather than reading live off
// QuotationLineItems, so editing here never rewrites what a Director
// already decided or what LPO Reconciliation already benchmarked against —
// it only updates what's shown live before/independent of that decision.
router.put('/:id', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { validUntil, paymentTerms, deliveryDays, notes, lineItems, submissionChannel } = req.body;
    const pool = await getPool();

    const tx = new (require('mssql').Transaction)(pool);
    await tx.begin();
    try {
      const totalAmount = (lineItems || []).reduce(
        (sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseFloat(li.qty) || 0), 0
      );

      await new (require('mssql').Request)(tx)
        .input('id',                sql.Int,            id)
        .input('ValidUntil',        sql.Date,           validUntil || null)
        .input('PaymentTerms',      sql.NVarChar(200),  paymentTerms || null)
        .input('DeliveryDays',      sql.Int,            deliveryDays || null)
        .input('TotalAmount',       sql.Decimal(14, 4), totalAmount)
        .input('Notes',             sql.NVarChar(1000), notes || null)
        .input('SubmissionChannel', sql.VarChar(20),    submissionChannel || null)
        .query(`
          UPDATE dbo.Quotations
          SET ValidUntil = @ValidUntil, PaymentTerms = @PaymentTerms,
              DeliveryDays = @DeliveryDays, TotalAmount = @TotalAmount,
              Notes = @Notes,
              SubmissionChannel = COALESCE(@SubmissionChannel, SubmissionChannel),
              UpdatedAt = GETUTCDATE()
          WHERE QuotationId = @id
        `);

      if (lineItems && lineItems.length > 0) {
        await new (require('mssql').Request)(tx)
          .input('id', sql.Int, id)
          .query('DELETE FROM dbo.QuotationLineItems WHERE QuotationId = @id');

        for (const li of lineItems) {
          const unitPrice = li.isNotAvailable ? 0 : (parseFloat(li.unitPrice) || 0);
          const qty       = li.isNotAvailable ? 0 : (parseFloat(li.qty) || 0);
          await new (require('mssql').Request)(tx)
            .input('QuotationId',        sql.Int,            id)
            .input('RequisitionItemId',  sql.Int,            parseInt(li.requisitionItemId, 10))
            .input('UnitPrice',          sql.Decimal(12, 4), unitPrice)
            .input('Qty',                sql.Decimal(12, 2), qty)
            .input('Brand',              sql.NVarChar(150), li.isNotAvailable ? null : (li.brand || null))
            .input('QualityDescription', sql.NVarChar(500), li.isNotAvailable ? null : (li.qualityDescription || null))
            .input('IsVatInclusive',     sql.Bit,           li.isVatInclusive ? 1 : 0)
            .input('Notes',              sql.NVarChar(500), li.notes || null)
            .input('AlternateUnitPrices', sql.NVarChar(500), li.isNotAvailable ? null : (li.alternatePrices || null))
            .input('IsNotAvailable',     sql.Bit,            li.isNotAvailable ? 1 : 0)
            .query(`
              INSERT INTO dbo.QuotationLineItems
                (QuotationId, RequisitionItemId, UnitPrice, Qty, Brand, QualityDescription, IsVatInclusive, Notes, AlternateUnitPrices, IsNotAvailable)
              VALUES (@QuotationId, @RequisitionItemId, @UnitPrice, @Qty, @Brand, @QualityDescription, @IsVatInclusive, @Notes, @AlternateUnitPrices, @IsNotAvailable)
            `);
        }
      }

      await tx.commit();
      res.json({ ok: true });
    } catch (txErr) {
      await tx.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/procurement/quotations/:id (withdraw) ────────────────────────
router.delete('/:id', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request().input('id', sql.Int, id).query(`
      UPDATE dbo.Quotations SET IsWithdrawn = 1, UpdatedAt = GETUTCDATE()
      WHERE QuotationId = @id
    `);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
