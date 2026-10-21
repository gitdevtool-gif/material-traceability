/**
 * LPO Reconciliation Service
 *
 * createReconciliation() is the shared "write one reconciliation record"
 * logic — extracted from what used to be inline in
 * routes/procurement/reconciliation.routes.js POST / so the manual route
 * and the automatic matcher below compute benchmark/variance and advance
 * requisition status identically. Behavior is unchanged from before this
 * extraction.
 *
 * Automatic matching (2026-09-05): there is no shared key between our
 * system and Busy ERP linking an LPO (dbo.PurOrder) back to the
 * requisition/RFQ that produced it — procurement has always had to search
 * Busy by supplier name and match it by hand (see reconciliation.routes.js
 * GET /pending-lpos). autoReconcilePendingAwards() runs on the same
 * schedule as the Busy requisition sync (procurement-sync.service.js) and
 * tries to close that gap.
 *
 * RFQ reference on the Busy PO (2026-09-15, pending on Busy's side): once
 * whoever raises the LPO in Busy starts recording our RFQ Number (e.g.
 * "RFQ-2026-0025") on it, that becomes an exact, unambiguous key —
 * checked FIRST for every share. The column doesn't exist in Busy yet at
 * the time this was written, so RFQ_REFERENCE_COLUMN's existence on
 * dbo.PurOrder is checked at the start of every run: if it's not there
 * yet, this whole path is skipped with zero risk (no query ever
 * references a column that might not exist), and every share falls
 * through to the pre-existing heuristic below unchanged. The moment Busy
 * adds the column, this starts working with no further deploy needed —
 * only the column name (BUSY_PURORDER_RFQ_COLUMN env var, default
 * 'RFQNo') might need setting if Busy's team picks something else.
 *
 * Heuristic fallback (used whenever the RFQ reference is absent or
 * doesn't resolve unambiguously): looks for Busy PurOrder rows from a
 * matching supplier whose item set FULLY COVERS every item this supplier
 * was awarded (extra items on the same LPO are fine — a missing one is
 * not). Only auto-creates a reconciliation when EXACTLY ONE PurOrder
 * ordno qualifies; zero or multiple candidates are left for procurement
 * to resolve by hand. This trades recall for safety — a wrong automatic
 * match would misreport real financials, so it only acts when confident.
 */
const { getPool, sql } = require('../db');
const { getErpPool, sql: erpSql } = require('../erpDb');
const logger = require('../logger');

// Must be a plain identifier (letters/digits/underscore) — validated below
// before ever being interpolated into a query, since it can't be bound as
// a normal parameter. Override via env if Busy's team lands on a
// different name than expected.
const RFQ_REFERENCE_COLUMN = process.env.BUSY_PURORDER_RFQ_COLUMN || 'RFQNo';

async function getRfqReferenceColumnIfPresent(erpPool) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(RFQ_REFERENCE_COLUMN)) {
    logger.error(`[LPOAutoReconcile] BUSY_PURORDER_RFQ_COLUMN ("${RFQ_REFERENCE_COLUMN}") is not a valid column name — ignoring it.`);
    return null;
  }
  const result = await erpPool.request()
    .input('table', erpSql.NVarChar(128), 'PurOrder')
    .input('column', erpSql.NVarChar(128), RFQ_REFERENCE_COLUMN)
    .query(`
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @table AND COLUMN_NAME = @column
    `);
  return result.recordset.length > 0 ? RFQ_REFERENCE_COLUMN : null;
}

/**
 * Insert one LPOReconciliation row and advance the linked requisition(s)
 * to 'Reconciled'. Returns { created: true, record } on success, or
 * { created: false, reason } if this ordno was already reconciled or no
 * requisitions could be resolved for the given rfqId/requisitionId.
 */
async function createReconciliation(pool, {
  busyPurOrdNo, rfqId, requisitionId, quoteEvaluationId, supplierId,
  busySupplier, busyDate, totalActualAmt, notes, reconciledByUserId,
}) {
  const existing = await pool.request()
    .input('ordno', sql.VarChar(50), String(busyPurOrdNo).trim())
    .query('SELECT LPOReconciliationId FROM dbo.LPOReconciliation WHERE BusyPurOrdNo = @ordno');
  if (existing.recordset.length > 0) {
    return { created: false, reason: 'This PurOrder ordno has already been reconciled' };
  }

  let requisitionIds = [];
  const parsedRfqId = rfqId ? parseInt(rfqId, 10) : null;
  const parsedRequisitionId = requisitionId ? parseInt(requisitionId, 10) : null;

  if (parsedRfqId) {
    const linkedResult = await pool.request()
      .input('rfqId', sql.Int, parsedRfqId)
      .query('SELECT RequisitionId FROM dbo.Requisitions WHERE RFQId = @rfqId');
    requisitionIds = linkedResult.recordset.map((r) => r.RequisitionId);
    if (requisitionIds.length === 0) {
      return { created: false, reason: 'No requisitions found linked to that RFQ' };
    }
  } else if (parsedRequisitionId) {
    requisitionIds = [parsedRequisitionId];
  }

  // Look up quoted total from winning evaluation — split awards (per-item,
  // migration 020) have no WinningQuotationId, so the quoted total for a
  // given supplier's share must be summed from QuoteEvaluationItems instead.
  let totalQuotedAmt = null;
  if (quoteEvaluationId && supplierId) {
    const quotedResult = await pool.request()
      .input('evalId', sql.Int, parseInt(quoteEvaluationId, 10))
      .input('supplierId', sql.Int, parseInt(supplierId, 10))
      .query(`
        SELECT SUM(qei.UnitPrice * qei.Qty) AS TotalAmount
        FROM dbo.QuoteEvaluationItems qei
        WHERE qei.QuoteEvaluationId = @evalId AND qei.SupplierId = @supplierId
      `);
    totalQuotedAmt = quotedResult.recordset[0]?.TotalAmount || null;
  }
  if (quoteEvaluationId && totalQuotedAmt === null) {
    const quotedResult = await pool.request()
      .input('evalId', sql.Int, parseInt(quoteEvaluationId, 10))
      .query(`
        SELECT q.TotalAmount
        FROM dbo.QuoteEvaluations ev
        JOIN dbo.Quotations q ON q.QuotationId = ev.WinningQuotationId
        WHERE ev.QuoteEvaluationId = @evalId
      `);
    totalQuotedAmt = quotedResult.recordset[0]?.TotalAmount || null;
  }

  // ERP benchmark: average unit price × quantities, summed across items
  // from ALL requisitions covered by this reconciliation.
  let benchmarkAmt = null;
  if (requisitionIds.length > 0) {
    try {
      const erpPool = await getErpPool();
      const idPlaceholders = requisitionIds.map((_, i) => `@r${i}`).join(',');
      const itemsRequest = pool.request();
      requisitionIds.forEach((rid, i) => itemsRequest.input(`r${i}`, sql.Int, rid));
      const itemsResult = await itemsRequest.query(
        // Busy knows code-resolved items by their raw code, not the
        // friendly ItemCodeLookup name — match on the code when present.
        `SELECT COALESCE(ItemCode, ItemName) AS ItemName, Qty FROM dbo.RequisitionItems WHERE RequisitionId IN (${idPlaceholders})`
      );

      let total = 0;
      for (const item of itemsResult.recordset) {
        const bRes = await erpPool.request()
          .input('itemName', erpSql.NVarChar(40), String(item.ItemName).substring(0, 40))
          .query(`
            SELECT AVG(CAST(Price AS FLOAT)) AS AvgPrice
            FROM dbo.PurOrder
            WHERE LTRIM(RTRIM([itemName])) = LTRIM(RTRIM(@itemName))
              AND [Date] >= DATEADD(year, -1, GETDATE())
              AND Price > 0
          `);
        const avg = bRes.recordset[0]?.AvgPrice;
        if (avg) total += avg * Number(item.Qty);
      }
      if (total > 0) benchmarkAmt = total;
    } catch {
      // Non-fatal
    }
  }

  const varianceAmt = totalQuotedAmt !== null
    ? Number(totalActualAmt) - Number(totalQuotedAmt)
    : null;

  const result = await pool.request()
    .input('RFQId',              sql.Int,            parsedRfqId)
    .input('RequisitionId',      sql.Int,            parsedRfqId ? null : parsedRequisitionId)
    .input('QuoteEvaluationId',  sql.Int,            quoteEvaluationId ? parseInt(quoteEvaluationId, 10) : null)
    .input('SupplierId',         sql.Int,            supplierId ? parseInt(supplierId, 10) : null)
    .input('BusyPurOrdNo',       sql.VarChar(50),    String(busyPurOrdNo).trim())
    .input('BusySupplier',       sql.NVarChar(200),  busySupplier || null)
    .input('BusyDate',           sql.Date,           busyDate || null)
    .input('TotalQuotedAmt',     sql.Decimal(14, 4), totalQuotedAmt)
    .input('TotalActualAmt',     sql.Decimal(14, 4), parseFloat(totalActualAmt))
    .input('BenchmarkAmt',       sql.Decimal(14, 4), benchmarkAmt)
    .input('VarianceAmt',        sql.Decimal(14, 4), varianceAmt)
    .input('ReconciledByUserId', sql.Int,            reconciledByUserId || null)
    .input('Notes',              sql.NVarChar(1000), notes || null)
    .query(`
      INSERT INTO dbo.LPOReconciliation
        (RFQId, RequisitionId, QuoteEvaluationId, SupplierId, BusyPurOrdNo, BusySupplier, BusyDate,
         TotalQuotedAmt, TotalActualAmt, BenchmarkAmt, VarianceAmt,
         ReconciledByUserId, Notes)
      OUTPUT INSERTED.*
      VALUES
        (@RFQId, @RequisitionId, @QuoteEvaluationId, @SupplierId, @BusyPurOrdNo, @BusySupplier, @BusyDate,
         @TotalQuotedAmt, @TotalActualAmt, @BenchmarkAmt, @VarianceAmt,
         @ReconciledByUserId, @Notes)
    `);

  // Mark every covered requisition as reconciled — one for the legacy
  // path, all linked requisitions together for a combined RFQ.
  if (requisitionIds.length > 0) {
    const idPlaceholders = requisitionIds.map((_, i) => `@r${i}`).join(',');
    const updateRequest = pool.request();
    requisitionIds.forEach((rid, i) => updateRequest.input(`r${i}`, sql.Int, rid));
    await updateRequest.query(`
      UPDATE dbo.Requisitions SET Status = 'Reconciled', UpdatedAt = GETUTCDATE()
      WHERE RequisitionId IN (${idPlaceholders})
    `);
  }

  return { created: true, record: result.recordset[0] };
}

const normalizeItemName = (s) => String(s || '').trim().toLowerCase();

/**
 * Scans every Director-approved award (QuoteEvaluations row) that isn't
 * reconciled yet and tries to auto-match it to a Busy PurOrder. See file
 * header for the matching rule and why it's deliberately conservative.
 */
async function autoReconcilePendingAwards() {
  let matched = 0;
  let skipped = 0;

  try {
    const pool = await getPool();
    const erpPool = await getErpPool();

    const rfqColumn = await getRfqReferenceColumnIfPresent(erpPool);
    if (rfqColumn) {
      logger.info(`[LPOAutoReconcile] Busy PurOrder has "${rfqColumn}" — matching by RFQ reference first, heuristic as fallback.`);
    }

    // One row per (RFQ, awarded supplier) share that's been approved
    // (a QuoteEvaluations row exists — that IS the Director approval,
    // see evaluation.routes.js POST /) but has no reconciliation yet.
    // Mirrors GET /procurement/evaluation/awarded's split-award query.
    const pendingResult = await pool.request().query(`
      SELECT
        ev.QuoteEvaluationId, rfq.RFQId, rfq.RFQNumber,
        s.SupplierId, s.SupplierName,
        SUM(qei.UnitPrice * qei.Qty) AS TotalQuotedAmt
      FROM dbo.QuoteEvaluations ev
      JOIN dbo.RFQs rfq ON rfq.RFQId = ev.RFQId
      JOIN dbo.QuoteEvaluationItems qei ON qei.QuoteEvaluationId = ev.QuoteEvaluationId
      JOIN dbo.Suppliers s ON s.SupplierId = qei.SupplierId
      LEFT JOIN dbo.LPOReconciliation rec ON rec.RFQId = rfq.RFQId AND rec.SupplierId = s.SupplierId
      WHERE rec.LPOReconciliationId IS NULL AND ev.ApprovedAt IS NOT NULL
      GROUP BY ev.QuoteEvaluationId, rfq.RFQId, rfq.RFQNumber, s.SupplierId, s.SupplierName
    `);

    if (pendingResult.recordset.length === 0) {
      logger.info('[LPOAutoReconcile] No approved-but-unreconciled awards to check.');
      return { matched: 0, skipped: 0 };
    }

    const reconciledResult = await pool.request().query('SELECT BusyPurOrdNo FROM dbo.LPOReconciliation');
    const reconciledOrdNos = new Set(reconciledResult.recordset.map((r) => String(r.BusyPurOrdNo).trim()));

    for (const share of pendingResult.recordset) {
      let match = null;
      let matchNote = null;

      // ── Preferred: exact match via Busy's RFQ reference field, once it
      // exists there. RFQNo + Supplier is authoritative on its own — no
      // need for the item-name coverage check the heuristic relies on.
      if (rfqColumn) {
        const rfqRowsResult = await erpPool.request()
          .input('rfqNumber', erpSql.NVarChar(50), share.RFQNumber)
          .input('supplier', erpSql.NVarChar(210), `%${String(share.SupplierName).trim()}%`)
          .query(`
            SELECT LTRIM(RTRIM([ordno])) AS ordno, [Date], LTRIM(RTRIM([Supplier])) AS Supplier, [Amt]
            FROM dbo.PurOrder
            WHERE LTRIM(RTRIM([${rfqColumn}])) = LTRIM(RTRIM(@rfqNumber))
              AND LTRIM(RTRIM([Supplier])) LIKE @supplier
          `);

        const byOrdnoViaRfq = {};
        for (const row of rfqRowsResult.recordset) {
          const key = String(row.ordno).trim();
          if (!key || reconciledOrdNos.has(key)) continue;
          if (!byOrdnoViaRfq[key]) {
            byOrdnoViaRfq[key] = { ordno: key, date: row.Date, supplier: row.Supplier, total: 0 };
          }
          byOrdnoViaRfq[key].total += Number(row.Amt) || 0;
        }
        const rfqCandidates = Object.values(byOrdnoViaRfq);
        if (rfqCandidates.length === 1) {
          match = rfqCandidates[0];
          matchNote = `matched Busy PurOrder ${match.ordno} to ${share.SupplierName}'s award on RFQ ${share.RFQNumber} via Busy's own RFQ reference field ("${rfqColumn}").`;
        }
        // rfqCandidates.length === 0 or > 1: fall through to the
        // heuristic below rather than giving up — a PO with no RFQNo
        // filled in yet, or an ambiguous one, should still get the old
        // chance at an item-name-coverage match.
      }

      // ── Fallback: supplier name + exact item-name coverage.
      if (!match) {
        const itemsResult = await pool.request()
          .input('evalId', sql.Int, share.QuoteEvaluationId)
          .input('supplierId', sql.Int, share.SupplierId)
          .query(`
            SELECT COALESCE(ri.ItemCode, ri.ItemName) AS ItemName
            FROM dbo.QuoteEvaluationItems qei
            JOIN dbo.RequisitionItems ri ON ri.RequisitionItemId = qei.RequisitionItemId
            WHERE qei.QuoteEvaluationId = @evalId AND qei.SupplierId = @supplierId
          `);
        const awardedItemNames = new Set(itemsResult.recordset.map((r) => normalizeItemName(r.ItemName)));
        if (awardedItemNames.size === 0) { skipped++; continue; }

        const erpRowsResult = await erpPool.request()
          .input('supplier', erpSql.NVarChar(210), `%${String(share.SupplierName).trim()}%`)
          .query(`
            SELECT LTRIM(RTRIM([ordno])) AS ordno, [Date], LTRIM(RTRIM([Supplier])) AS Supplier,
                   LTRIM(RTRIM([itemName])) AS itemName, [Amt]
            FROM dbo.PurOrder
            WHERE LTRIM(RTRIM([Supplier])) LIKE @supplier
          `);

        const byOrdno = {};
        for (const row of erpRowsResult.recordset) {
          const key = String(row.ordno).trim();
          if (!key || reconciledOrdNos.has(key)) continue;
          if (!byOrdno[key]) {
            byOrdno[key] = { ordno: key, date: row.Date, supplier: row.Supplier, itemNames: new Set(), total: 0 };
          }
          byOrdno[key].itemNames.add(normalizeItemName(row.itemName));
          byOrdno[key].total += Number(row.Amt) || 0;
        }

        // Unambiguous = exactly one ordno whose item set fully covers
        // every item this supplier was awarded. Extra items on the LPO
        // (e.g. bundled with an unrelated order) don't disqualify it — a
        // missing one does.
        const candidates = Object.values(byOrdno).filter((group) =>
          [...awardedItemNames].every((name) => group.itemNames.has(name))
        );

        if (candidates.length !== 1) {
          skipped++;
          continue;
        }
        match = candidates[0];
        matchNote = `matched Busy PurOrder ${match.ordno} to ${share.SupplierName}'s awarded items on RFQ ${share.RFQNumber} by supplier name + exact item-name match.`;
      }

      const outcome = await createReconciliation(pool, {
        busyPurOrdNo: match.ordno,
        rfqId: share.RFQId,
        quoteEvaluationId: share.QuoteEvaluationId,
        supplierId: share.SupplierId,
        busySupplier: match.supplier,
        busyDate: match.date,
        totalActualAmt: match.total,
        notes: `Auto-reconciled by system — ${matchNote}`,
        reconciledByUserId: null,
      });

      if (outcome.created) {
        matched++;
        logger.info(`[LPOAutoReconcile] Auto-reconciled RFQ ${share.RFQNumber} / ${share.SupplierName} against Busy ordno ${match.ordno}`);
      } else {
        skipped++;
      }
    }

    logger.info(`[LPOAutoReconcile] Done — ${matched} auto-reconciled, ${skipped} left for manual review.`);
    return { matched, skipped };
  } catch (err) {
    logger.error('[LPOAutoReconcile] Run failed:', err);
    return { matched: 0, skipped: 0, error: err.message };
  }
}

module.exports = { createReconciliation, autoReconcilePendingAwards };
