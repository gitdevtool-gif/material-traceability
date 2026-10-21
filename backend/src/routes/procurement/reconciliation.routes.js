/**
 * LPO Reconciliation Routes
 * Matches newly-created Busy PurOrder rows back to the originating
 * Requisition(s) / QuoteEvaluation and records variance vs quoted vs benchmark.
 *
 * Multi-requisition RFQs (2026-07-30): FIXED — this file never adopted
 * LPOReconciliation.RFQId (added by migration 016) at all; it was still
 * entirely on the old single-RequisitionId model, out of step with the
 * "reconciliation now matches at the RFQ level" comment already in
 * evaluation.routes.js.
 *
 *   - POST / now accepts rfqId as the primary way to reconcile a bundled
 *     RFQ: benchmark is computed across items from ALL requisitions linked
 *     to that RFQ, ALL of those requisitions move to 'Reconciled', and the
 *     row is stored with RFQId set (RequisitionId left NULL for these).
 *   - requisitionId is still accepted for the legacy "manual match to a
 *     single requisition outside the RFQ flow" case migration 016 says to
 *     keep valid — unchanged behavior for that path.
 *   - GET / resolves the requisition(s) for BOTH old and new rows via
 *     COALESCE(rec.RFQId, <the RFQId of rec.RequisitionId's requisition>)
 *     — every requisition already has an RFQId (backfilled by migration
 *     016 step 2), so this one lookup correctly aggregates requisitions
 *     for legacy rows and combined-RFQ rows alike, without needing two
 *     separate code paths.
 */
const express = require('express');
const { getPool } = require('../../db');
const { getErpPool, sql: erpSql } = require('../../erpDb');
const { authenticate, authorize } = require('../../middleware/auth');
const { createReconciliation } = require('../../services/lpo-reconciliation.service');

const router = express.Router();

// ── GET /api/procurement/reconciliation/pending-lpos ─────────────────────────
// Busy PurOrder rows not yet reconciled in our system
router.get('/pending-lpos', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const { dateFrom, dateTo, search } = req.query;
    const erpPool = await getErpPool();
    const localPool = await getPool();

    // Get already-reconciled ordnos
    const reconciledResult = await localPool.request()
      .query('SELECT BusyPurOrdNo FROM dbo.LPOReconciliation');
    const reconciledSet = new Set(reconciledResult.recordset.map((r) => r.BusyPurOrdNo));

    const erpReq = erpPool.request();
    let where = '1=1';
    if (dateFrom) { where += ' AND [Date] >= @dateFrom'; erpReq.input('dateFrom', erpSql.DateTime, new Date(dateFrom)); }
    if (dateTo)   { where += ' AND [Date] <= @dateTo';   erpReq.input('dateTo',   erpSql.DateTime, new Date(dateTo));   }
    if (search)   {
      where += ' AND (LTRIM(RTRIM([ordno])) LIKE @search OR LTRIM(RTRIM([itemName])) LIKE @search OR LTRIM(RTRIM([Supplier])) LIKE @search)';
      erpReq.input('search', erpSql.NVarChar(100), `%${search}%`);
    }

    const lpoResult = await erpReq.query(`
      SELECT
        [Date],
        LTRIM(RTRIM([Supplier]))  AS Supplier,
        LTRIM(RTRIM([ordno]))     AS ordno,
        LTRIM(RTRIM([itemName]))  AS itemName,
        [Qty], [Price], [Amt],
        LTRIM(RTRIM([MatCenter])) AS MatCenter,
        [ApprovalStatus]
      FROM dbo.PurOrder
      WHERE ${where}
      ORDER BY [Date] DESC, LTRIM(RTRIM([ordno]))
    `);

    // Group by trimmed ordno, exclude already reconciled
    const grouped = {};
    for (const row of lpoResult.recordset) {
      const key = String(row.ordno).trim();
      if (reconciledSet.has(key)) continue;
      if (!grouped[key]) {
        grouped[key] = {
          ordno:         key,
          date:          row.Date,
          supplier:      String(row.Supplier || '').trim(),
          matCenter:     String(row.MatCenter || '').trim(),
          approvalStatus: row.ApprovalStatus,
          items:         [],
          totalAmt:      0,
        };
      }
      grouped[key].items.push(row);
      grouped[key].totalAmt += Number(row.Amt) || 0;
    }

    res.json(Object.values(grouped).sort((a, b) => new Date(b.date) - new Date(a.date)));
  } catch (err) { next(err); }
});

// ── GET /api/procurement/reconciliation ──────────────────────────────────────
// List of completed reconciliations. Resolves linked requisition(s) for
// BOTH legacy (RequisitionId-only) and combined-RFQ (RFQId) rows via one
// COALESCE, since every requisition already carries an RFQId (backfilled
// by migration 016) — no need for two separate lookup paths.
router.get('/', authenticate, authorize('Admin', 'Procurement', 'Director'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        rec.*,
        rfq.RFQNumber,
        reqAgg.BusyOrdNoList AS RequisitionOrdNo,
        ev.WinningQuotationId, COALESCE(splitSup.SupplierName, s.SupplierName) AS WinningSupplierName,
        u.FullName AS ReconciledByName
      FROM dbo.LPOReconciliation rec
      LEFT JOIN dbo.Requisitions legacyReq ON legacyReq.RequisitionId = rec.RequisitionId
      LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = COALESCE(rec.RFQId, legacyReq.RFQId)
      OUTER APPLY (
        SELECT STRING_AGG(r2.BusyOrdNo, ', ') AS BusyOrdNoList
        FROM dbo.Requisitions r2
        WHERE r2.RFQId = COALESCE(rec.RFQId, legacyReq.RFQId)
      ) reqAgg
      LEFT JOIN dbo.QuoteEvaluations ev ON ev.QuoteEvaluationId = rec.QuoteEvaluationId
      LEFT JOIN dbo.Quotations q ON q.QuotationId = ev.WinningQuotationId
      LEFT JOIN dbo.Suppliers s ON s.SupplierId = q.SupplierId
      LEFT JOIN dbo.Suppliers splitSup ON splitSup.SupplierId = rec.SupplierId
      LEFT JOIN dbo.Users u ON u.UserId = rec.ReconciledByUserId
      ORDER BY rec.ReconciledAt DESC
    `);
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/reconciliation ─────────────────────────────────────
// Create a reconciliation record — EITHER by matching a Busy PurOrder ordno
// to a combined RFQ (rfqId, the current/primary path for anything created
// after migration 016), OR to a single requisition directly (requisitionId,
// the legacy manual-match path kept valid per migration 016's comments).
router.post('/', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const {
      busyPurOrdNo,
      rfqId,             // primary path — combined RFQ (0 or more requisitions)
      requisitionId,     // legacy path — single requisition, outside RFQ flow
      quoteEvaluationId, // optional
      supplierId,        // required to reconcile ONE supplier's share of a split-awarded RFQ
      busySupplier,
      busyDate,
      totalActualAmt,
      notes,
    } = req.body;

    if (!busyPurOrdNo || totalActualAmt === undefined) {
      return res.status(400).json({ error: 'busyPurOrdNo and totalActualAmt are required' });
    }

    const pool = await getPool();

    const outcome = await createReconciliation(pool, {
      busyPurOrdNo, rfqId, requisitionId, quoteEvaluationId, supplierId,
      busySupplier, busyDate, totalActualAmt, notes,
      reconciledByUserId: req.user.userId,
    });

    if (!outcome.created) {
      const status = outcome.reason.includes('already been reconciled') ? 409 : 404;
      return res.status(status).json({ error: outcome.reason });
    }

    res.status(201).json(outcome.record);
  } catch (err) { next(err); }
});

module.exports = router;