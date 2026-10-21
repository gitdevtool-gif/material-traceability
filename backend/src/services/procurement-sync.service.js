/**
 * Procurement Sync Service
 * Polls Busy ERP dbo.PurIndents for newly-approved requisitions (ApprovalStatus = 0)
 * and ingests them into local Requisitions + RequisitionItems tables.
 *
 * ApprovalStatus semantics in Busy:
 *   1 = keyed by Stores, awaiting Ops Manager approval
 *   0 = approved by Ops Manager — ready for procurement
 *
 * Item categorization:
 *   Busy ERP's [category] column on PurIndents is the sole source of
 *   truth — it is a mandatory field there and is used as-is, with no
 *   local pattern-matching or manual mapping. If Busy unexpectedly sends
 *   a blank category for a line item, it is logged as a data-quality
 *   warning and stored as NULL locally rather than guessed at.
 *
 * Ops Manager approval gate (migration 021): newly-ingested requisitions
 * land with Status = 'PendingOpsApproval' instead of the previous default,
 * making them invisible to Procurement (requisitions.routes.js's default
 * GET / excludes this status) until an Ops Manager reviews each item
 * against dbo.ReorderStatus and Approves (-> 'Pending', enters the
 * existing RFQ dispatch flow unchanged) or Rejects (-> 'RejectedByOps').
 * See routes/procurement/requisition-approval.routes.js.
 *
 * MatCenter-based gating: the Ops Manager gate above only makes sense for
 * requests raised on the actual factory floor (Mat Centres named F1, F1w,
 * F2P, F2W, F3, F4, F5, F6, F8, F9, ...) where stock is consumed against
 * live production and needs a sanity check against dbo.ReorderStatus.
 * Everything else (Admin, Boiler, CENTRAL LAB, CENTRAL STORES,
 * ENVIRONMENT, HR, KAV227, KCP 659X, Qa, sales returns sylvia, Security,
 * Transport, Workshop, ...) skips the gate entirely and syncs straight in
 * with Status = 'Pending', immediately visible to Procurement.
 *
 * Rule: any MatCenter that starts with "F" (case-insensitive, after
 * trimming) requires Ops Manager approval; every other MatCenter
 * auto-passes through.
 *
 * Runs on a configurable interval (env: PROCUREMENT_SYNC_INTERVAL_MS, default 15 min).
 */
const { getErpPool, sql: erpSql } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');
const { autoReconcilePendingAwards } = require('./lpo-reconciliation.service');
const { applyItemCodeLookupToRequisitionItems } = require('./requisition-item-catalog.service');
// sendApprovalEmailForRequisition is required lazily inside
// syncRequisitions() below, right where it's used, rather than importing
// the whole Express route module (requisition-approval.routes.js) at
// service-startup time for the sake of one helper function.

const SYNC_INTERVAL_MS =
  parseInt(process.env.PROCUREMENT_SYNC_INTERVAL_MS, 10) || 15 * 60 * 1000;

// Only the numbered factory floors F1-F10 (and their sub-areas, e.g.
// "F1w", "F2P", "F2W", "F3F" — verified live: heavily used, e.g. F2P has
// 58 requisitions) go through the Ops Manager approval gate — everything
// else auto-passes straight to Central Stores -> Procurement.
//
// 2026-09-16: tightened from a bare "/^f/i" (matches anything starting
// with F), which incorrectly swept in non-factory buckets that also
// happen to start with "F" — FARM, Farm-chris, FIXED ASSETS, FOC,
// FORKLIFT-CATERPILLAR (verified live against Busy's factory list) — none
// of which are actual factory floors. Matches "F" + a digit 1-10 not
// immediately followed by another digit, so "F1"/"F10"/"F1w"/"F2P" all
// match but "F11" (if it ever exists) and the buckets above don't.
function matCenterRequiresOpsApproval(matCenter) {
  return /^f(10|[1-9])(?!\d)/i.test(String(matCenter || '').trim());
}

/**
 * Core sync logic — safe to call multiple times (idempotent per ordno).
 * Returns { synced: number, skipped: number }
 */
async function syncRequisitions() {
  logger.info('[ProcurementSync] Starting sync run...');
  let synced = 0;
  let skipped = 0;

  // Self-heal: resolve any bare item codes already stored (requisitions
  // ingested before their code was mapped in ItemCodeLookup). Independent
  // of ERP connectivity, so it runs even if the Busy fetch below fails.
  try {
    const healed = await applyItemCodeLookupToRequisitionItems();
    if (healed > 0) logger.info(`[ProcurementSync] Resolved ${healed} stored item code(s) to real names via ItemCodeLookup`);
  } catch (err) {
    logger.warn(`[ProcurementSync] Item code lookup pass failed: ${err.message}`);
  }

  try {
    const [localPool, erpPool] = await Promise.all([getPool(), getErpPool()]);

    // Build set of already-ingested ordnos
    const existingRows = await localPool
      .request()
      .query('SELECT BusyOrdNo FROM dbo.Requisitions');
    const existingOrdNos = new Set(existingRows.recordset.map((r) => r.BusyOrdNo));

    // Pull all approved (ApprovalStatus = 0) indents from Busy ERP view.
    // ordno has leading spaces in Busy — trim to use as dedup key.
    // category is Busy's own item-category mapping, now maintained there —
    // preferred over local ItemCategoryMap pattern matching when present.
    const indentsResult = await erpPool.request().query(`
      SELECT
        [Date],
        LTRIM(RTRIM([Warehouse]))  AS Warehouse,
        LTRIM(RTRIM([ordno]))      AS ordno,
        LTRIM(RTRIM([itemName]))   AS itemName,
        [Qty], [Price], [Amt],
        LTRIM(RTRIM([MatCenter]))  AS MatCenter,
        LTRIM(RTRIM([category]))   AS category,
        [ApprovalStatus]
      FROM dbo.PurIndents
      WHERE ApprovalStatus = 0
      ORDER BY [Date] ASC, LTRIM(RTRIM([ordno])) ASC
    `);

    if (indentsResult.recordset.length === 0) {
      logger.info('[ProcurementSync] No approved indents found in Busy.');
      return { synced: 0, skipped: 0 };
    }

    // Group rows by ordno (already trimmed by SQL LTRIM/RTRIM)
    const byOrdNo = {};
    for (const row of indentsResult.recordset) {
      const key = String(row.ordno).trim();
      if (!byOrdNo[key]) byOrdNo[key] = { header: row, items: [] };
      byOrdNo[key].items.push(row);
    }

    for (const [ordno, group] of Object.entries(byOrdNo)) {
      if (existingOrdNos.has(ordno)) {
        skipped++;
        continue;
      }

      const { header, items } = group;

      // MatCenters starting with "F" (factory floors) are gated through
      // Ops Manager approval; everything else auto-passes straight to
      // Procurement (see matCenterRequiresOpsApproval above).
      const initialStatus = matCenterRequiresOpsApproval(header.MatCenter)
        ? 'PendingOpsApproval'
        : 'Pending';

      // Insert Requisition header in a transaction
      const tx = new (require('mssql').Transaction)(localPool);
      try {
        await tx.begin();

        const reqResult = await new (require('mssql').Request)(tx)
          .input('BusyOrdNo',  sql.NVarChar(25),  ordno)
          .input('BusyDate',   sql.DateTime,      header.Date)
          .input('Warehouse',  sql.NVarChar(40),  header.Warehouse || null)
          .input('MatCenter',  sql.NVarChar(40),  header.MatCenter || null)
          .input('Status',     sql.VarChar(30),   initialStatus)
          .query(`
            INSERT INTO dbo.Requisitions (BusyOrdNo, BusyDate, Warehouse, MatCenter, Status)
            OUTPUT INSERTED.RequisitionId
            VALUES (@BusyOrdNo, @BusyDate, @Warehouse, @MatCenter, @Status)
          `);

        const requisitionId = reqResult.recordset[0].RequisitionId;

        // Insert each line item
        for (const item of items) {
          // Busy's category is mandatory and authoritative — used as-is.
          // No local pattern matching, no manual mapping.
          const category = item.category ? String(item.category).trim() : null;

          if (!category) {
            logger.warn(
              `[ProcurementSync] ordno ${ordno}, item "${item.itemName}": ` +
              `Busy returned a blank category despite it being a mandatory field. Stored as NULL.`
            );
          }

          await new (require('mssql').Request)(tx)
            .input('RequisitionId', sql.Int,           requisitionId)
            .input('ItemName',      sql.NVarChar(40),  String(item.itemName).trim())
            .input('Qty',           sql.Float,         item.Qty  ?? 0)
            .input('BusyPrice',     sql.Float,         item.Price ?? null)
            .input('BusyAmt',       sql.Float,         item.Amt   ?? null)
            .input('Category',      sql.NVarChar(100), category)
            .query(`
              INSERT INTO dbo.RequisitionItems
                (RequisitionId, ItemName, Qty, BusyPrice, BusyAmt, Category)
              VALUES
                (@RequisitionId, @ItemName, @Qty, @BusyPrice, @BusyAmt, @Category)
            `);
        }

        // Busy sends code-only items (e.g. "ING-0141") as-is — swap them
        // for the real name from the Admin-managed ItemCodeLookup so
        // Ops/Procurement/suppliers never see the bare code.
        await applyItemCodeLookupToRequisitionItems(requisitionId, tx);

        await tx.commit();
        synced++;
        logger.info(
          `[ProcurementSync] Ingested ordno ${ordno} (MatCenter: ${header.MatCenter || 'n/a'}) — ${items.length} item(s), status=${initialStatus}`
        );

        // Notify the Ops Manager by email as soon as a requisition needs
        // their review — fire-and-forget, never blocks the sync loop.
        if (initialStatus === 'PendingOpsApproval') {
          const { sendApprovalEmailForRequisition } = require('../routes/procurement/requisition-approval.routes');
          sendApprovalEmailForRequisition(requisitionId).catch((emailErr) =>
            logger.error(`[ProcurementSync] Failed to send approval email for ordno ${ordno}:`, emailErr)
          );
        }
      } catch (txErr) {
        await tx.rollback().catch(() => {});
        logger.error(`[ProcurementSync] Failed to ingest ordno ${ordno}:`, txErr);
      }
    }

    logger.info(
      `[ProcurementSync] Done — ${synced} new requisition(s) ingested, ${skipped} skipped.`
    );
    return { synced, skipped };
  } catch (err) {
    logger.error('[ProcurementSync] Sync run failed:', err);
    throw err;
  }
}

let _syncTimer = null;

// Runs on the same interval this job always has — see
// lpo-reconciliation.service.js for what "auto" means here (conservative,
// skips anything ambiguous) and why it's tied to a recurring schedule
// rather than firing once at approval time: the Busy LPO usually doesn't
// exist yet at that moment, so it has to keep checking back.
async function runAutoReconcile() {
  try {
    await autoReconcilePendingAwards();
  } catch (err) {
    logger.error('[ProcurementSync] LPO auto-reconcile error:', err);
  }
}

// In-system purchase indent creation (2026-09-15): syncRequisitions() is
// no longer called automatically — requisitions are now raised directly
// in this system (see requisition-create.routes.js) instead of arriving
// via Busy's PurIndents. The function itself, and the manual "Sync Now"
// trigger in requisitions.routes.js, are left in place rather than
// deleted, in case Busy-side ingestion is ever needed again. This job's
// interval keeps running for LPO auto-reconciliation alone, which is
// unrelated to how requisitions are created and must not stop.
function startSyncJob() {
  if (_syncTimer) return; // already running
  logger.info(
    `[ProcurementSync] LPO auto-reconcile job started (every ${SYNC_INTERVAL_MS / 1000}s) — ` +
    `requisition sync from Busy is disabled (in-system creation only)`
  );

  runAutoReconcile();
  _syncTimer = setInterval(runAutoReconcile, SYNC_INTERVAL_MS);
}

function stopSyncJob() {
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = null;
    logger.info('[ProcurementSync] Polling job stopped.');
  }
}

module.exports = { syncRequisitions, startSyncJob, stopSyncJob, matCenterRequiresOpsApproval };