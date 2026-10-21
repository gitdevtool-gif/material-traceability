/**
 * Aging Sync Service
 *
 * REBUILT 2026-10-18 on services/stock.service.js getAllBatchBalances():
 * one row per item × store × batch with its TRUE remaining balance, valued
 * at the batch's receipt price. dbo.BatchwiseStock (the source until now)
 * grouped by quantity and price with no RecType filter, so issues never
 * netted against their batch and supplier challans / customer orders /
 * bills showed up as extra "factories" — on 2026-10-17 dbo.AgingStock held
 * 287,614 rows over 1,019 "factories", positive rows totalling KES 3.9bn
 * against nearly as much negative. The × -1 below was a workaround for that
 * view's signs; true balances are positive, so it's gone. Only real stores
 * (Material Centres) appear; "Materials Consumable" (already consumed) is
 * excluded, as everywhere else. Row identity: Value1 now carries the Busy
 * item code and Value3 the batch's unit price, so UQ_AgingStock_Batch is
 * effectively item + store + batch. The first sync after this change
 * replaces every old row (the MERGE's NOT MATCHED BY SOURCE clause).
 *
 * --- history below kept for reference ---
 *
 * Pulls batch-wise stock from the Busy ERP view dbo.BatchwiseStock and
 * MERGEs it into local dbo.AgingStock, with Qty and Amount multiplied by -1.
 *
 * NOTE (2026-09-24): this previously read dbo.BatchwiseStockExcluded, a
 * separate view restricted to a factory allow-list (F1..F10, BIG COLD,
 * CENTRAL STORES, ...). BatchwiseStock is the view the business uses; it
 * is NOT factory-filtered — its "Factory" column also carries customers,
 * suppliers, vehicle plates and cost centers, so those rows now appear
 * too. Filter by factory on the page if only production factories are
 * wanted.
 *
 * AgeDays is NEVER stored here — it's computed at query time in
 * aging.routes.js via DATEDIFF against BatchDate, so it stays accurate to
 * "now" even between syncs. BatchDate itself CAN be NULL (defensive —
 * haven't seen it in practice, but Tran3.Date is not enforced NOT NULL on
 * the ERP side); aging.routes.js buckets those rows as 'Unknown' rather
 * than letting them silently fall into '180+'.
 *
 * Every sync fully reconciles dbo.AgingStock to match the ERP view's
 * CURRENT contents — a batch no longer returned by the view (consumed,
 * sold, adjusted away in Busy) is deleted here too (2026-09-23 bug fix;
 * see the MERGE's WHEN NOT MATCHED BY SOURCE clause below). Before this
 * fix, stale rows were left in place forever: verified live against
 * production data, 9,321 such ghost batches had accumulated, overstating
 * "total capital tied up" by KES 347.3M (~12% of the reported total) with
 * stock that no longer exists anywhere in Busy.
 *
 * Read-only against Busy ERP. Writes nothing back.
 */

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');
const stockService = require('./stock.service');

async function syncAgingStock() {
  logger.info('[AgingSync] Starting sync…');

  const [erpPool, localPool] = await Promise.all([getErpPool(), getPool()]);

  // ── 1. Pull batch data from the ERP view dbo.BatchwiseStock ─────────────
  // (2026-09-24: switched from BatchwiseStockExcluded, which is a different,
  // factory-allow-listed view — the page was showing 115k rows from that
  // view instead of the 255k in BatchwiseStock.) No Qty filter. Qty and
  // Amount are multiplied by -1 on the way in (per business request,
  // 2026-09-25); the frontend displays the stored values as-is (no Math.abs).
  let erpRows;
  try {
    erpRows = await stockService.getAllBatchBalances(erpPool);
  } catch (erpErr) {
    logger.error('[AgingSync] ERP query failed:', erpErr);
    throw erpErr;
  }

  logger.info(`[AgingSync] Busy: ${erpRows.length} batch(es) with stock remaining`);

  // Batches with no priced receipt of their own (opening batches carried
  // into the year, stock that arrived by transfer) — value them at the
  // item's average purchase price over 12 months, else its last purchase.
  const unpriced = [...new Set(erpRows.filter((b) => !b.unitPrice).map((b) => b.itemCode))];
  if (unpriced.length) {
    const [avg, last] = await Promise.all([
      stockService.getAvgInwardPrice(erpPool, unpriced),
      stockService.getLastPurchase(erpPool, unpriced),
    ]);
    // Items made here, not bought (finished goods, WIP): average production
    // cost from Busy's production vouchers (VchType 6 inward rows), 12 months.
    const madeCodes = unpriced.filter((c) => !avg.get(c) && !last.get(c)?.price);
    const prodCost = new Map();
    if (madeCodes.length) {
      const r = await erpPool.request().query(`
        SELECT MasterCode1 AS ItemCode, SUM(D5) / NULLIF(SUM(D1), 0) AS Cost
        FROM dbo.Tran2
        WHERE RecType = 2 AND VchType = 6 AND Value1 > 0 AND D1 > 0 AND [Date] >= DATEADD(month, -12, GETDATE())
          AND MasterCode1 IN (${madeCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite).join(',')})
        GROUP BY MasterCode1`);
      for (const row of r.recordset) if (Number(row.Cost) > 0) prodCost.set(row.ItemCode, Number(row.Cost));
    }
    let filled = 0;
    for (const b of erpRows) {
      if (b.unitPrice) continue;
      const price = avg.get(b.itemCode) || last.get(b.itemCode)?.price || prodCost.get(b.itemCode) || 0;
      if (price) { b.unitPrice = Math.round(price * 100) / 100; b.amount = Math.round(b.qty * price * 100) / 100; filled++; }
    }
    logger.info(`[AgingSync] Priced ${filled} batch(es) from the item's purchase price / production cost (no receipt price of their own); ${erpRows.filter((b) => !b.unitPrice).length} still unpriced`);
  }

  if (erpRows.length === 0) {
    logger.warn('[AgingSync] No rows returned — skipping MERGE');
    return { success: true, synced: 0 };
  }

  // ── 2. Shape rows for the MERGE ───────────────────────────────────────────
  const rows = erpRows
    .map(b => ({
      ItemName:    String(b.itemName || '').trim().slice(0, 200),
      Category:    b.group ? String(b.group).trim().slice(0, 80) : 'Uncategorized',
      Factory:     String(b.store || '').trim().slice(0, 80),
      BatchNo:     String(b.batchNo || '').trim().slice(0, 50),
      MasterCode2: b.storeCode,
      Value1:      b.itemCode,              // Busy item code (row identity)
      Value3:      b.unitPrice ?? 0,        // batch receipt price
      VchCode:     null,
      SrNo:        null,
      BatchDate:   b.batchDate || null,
      DueDate:     b.dueDate || null,
      Qty:         b.qty,
      Amount:      b.amount,
    }))
    // Skip rows missing an identity key (blank ItemName/Factory would break
    // the unique constraint and aren't meaningful for a factory report anyway).
    .filter(r => r.ItemName && r.Factory)
    // Two batch numbers that only differ beyond 50 characters would collide
    // on UQ_AgingStock_Batch after truncation — combine them.
    .reduce((acc, r) => {
      const key = [r.ItemName, r.Factory, r.BatchNo, r.MasterCode2, r.Value1, r.Value3].join('\u0001');
      const prev = acc.map.get(key);
      if (prev) {
        prev.Qty += r.Qty; prev.Amount += r.Amount;
        if (r.BatchDate && (!prev.BatchDate || r.BatchDate < prev.BatchDate)) prev.BatchDate = r.BatchDate;
      } else { acc.map.set(key, r); acc.list.push(r); }
      return acc;
    }, { map: new Map(), list: [] }).list;

  const synced = rows.length;

  // ── 3. Stage in chunks, then MERGE from the staging table ────────────────
  // BatchwiseStock returns 255k+ rows; a single OPENJSON-into-MERGE of that
  // size exceeds the pool's 120s requestTimeout (see config.js — tedious
  // has no working per-request override). So: inside one transaction (a
  // #temp table is per-connection, the transaction pins the connection),
  // load #AgingStage in STAGE_CHUNK-row batches, index it on the match
  // key, then MERGE. The transaction keeps the swap atomic — the page
  // never sees a half-synced table, and any failure rolls everything back.
  const STAGE_CHUNK = 20000;
  const tx = new sql.Transaction(localPool);
  await tx.begin();
  try {
    // .batch(), not .query(): query() runs through sp_executesql, which
    // would drop the #temp table as soon as that call returned.
    await new sql.Request(tx).batch(`
      CREATE TABLE #AgingStage (
        ItemName    NVARCHAR(200) NOT NULL,
        Category    NVARCHAR(80)  NULL,
        Factory     NVARCHAR(80)  NOT NULL,
        BatchNo     NVARCHAR(50)  NOT NULL,
        MasterCode2 INT           NULL,
        Value1      FLOAT         NULL,
        Value3      FLOAT         NULL,
        VchCode     INT           NULL,
        SrNo        INT           NULL,
        BatchDate   DATETIME      NULL,
        DueDate     DATETIME      NULL,
        Qty         FLOAT         NULL,
        Amount      FLOAT         NULL
      );
    `);

    for (let i = 0; i < rows.length; i += STAGE_CHUNK) {
      await new sql.Request(tx)
        .input('jsonData', sql.NVarChar(sql.MAX), JSON.stringify(rows.slice(i, i + STAGE_CHUNK)))
        .query(`
          INSERT INTO #AgingStage
          SELECT * FROM OPENJSON(@jsonData) WITH (
            ItemName    NVARCHAR(200) '$.ItemName',
            Category    NVARCHAR(80)  '$.Category',
            Factory     NVARCHAR(80)  '$.Factory',
            BatchNo     NVARCHAR(50)  '$.BatchNo',
            MasterCode2 INT           '$.MasterCode2',
            Value1      FLOAT         '$.Value1',
            Value3      FLOAT         '$.Value3',
            VchCode     INT           '$.VchCode',
            SrNo        INT           '$.SrNo',
            BatchDate   DATETIME      '$.BatchDate',
            DueDate     DATETIME      '$.DueDate',
            Qty         FLOAT         '$.Qty',
            Amount      FLOAT         '$.Amount'
          );
        `);
    }

    await new sql.Request(tx).query(`
      CREATE CLUSTERED INDEX IX_AgingStage_Key
        ON #AgingStage (ItemName, Factory, BatchNo, MasterCode2, Value1, Value3);
    `);

    await new sql.Request(tx).query(`
        MERGE dbo.AgingStock AS target
        USING #AgingStage AS source
          ON  target.ItemName    = source.ItemName
          AND target.Factory     = source.Factory
          AND target.BatchNo     = source.BatchNo
          AND target.MasterCode2 = source.MasterCode2
          AND target.Value1      = source.Value1
          AND target.Value3      = source.Value3
        WHEN MATCHED THEN
          UPDATE SET
            Category  = source.Category,
            VchCode   = source.VchCode,
            SrNo      = source.SrNo,
            BatchDate = source.BatchDate,
            DueDate   = source.DueDate,
            Qty       = source.Qty,
            Amount    = source.Amount,
            SyncedAt  = SYSUTCDATETIME()
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (ItemName, Category, Factory, BatchNo, MasterCode2, Value1, Value3,
                  VchCode, SrNo, BatchDate, DueDate, Qty, Amount, SyncedAt)
          VALUES (source.ItemName, source.Category, source.Factory, source.BatchNo,
                  source.MasterCode2, source.Value1, source.Value3,
                  source.VchCode, source.SrNo, source.BatchDate, source.DueDate,
                  source.Qty, source.Amount, SYSUTCDATETIME())
        -- 2026-09-23 bug fix: batches no longer returned by the ERP query
        -- (fully consumed/sold/adjusted away in Busy) used to be left in
        -- place forever, un-deleted — verified live this had accumulated
        -- 9,321 such "ghost" rows, overstating total capital tied up by
        -- KES 347.3M (~12% of the reported total) with stock that no
        -- longer exists. Aging Analysis is meant to reflect what's
        -- actually sitting on the floor right now, not a historical
        -- ledger, so a batch that's gone from the source is deleted here
        -- too — every sync now leaves dbo.AgingStock exactly matching
        -- the live ERP view's current contents.
        WHEN NOT MATCHED BY SOURCE THEN DELETE;
      `);
    await tx.commit();
  } catch (mergeErr) {
    logger.error('[AgingSync] MERGE failed:', mergeErr);
    try { await tx.rollback(); } catch (_) { /* already aborted by the server */ }
    throw mergeErr;
  }

  logger.info(`[AgingSync] Done — ${synced} factory batch(es) synced.`);
  return { success: true, synced };
}

// ── Background polling job ──────────────────────────────────────────────────
// Default: every 60 minutes. Override with env var AGING_SYNC_INTERVAL_MS.
const SYNC_INTERVAL_MS =
  parseInt(process.env.AGING_SYNC_INTERVAL_MS, 10) || 60 * 60 * 1000;

let timer = null;

function startAgingSyncJob() {
  if (timer) return; // already running

  logger.info(`[AgingSync] Scheduler started. Interval = ${SYNC_INTERVAL_MS / 1000}s`);

  syncAgingStock().catch(err => {
    logger.error('[AgingSync] Startup sync error (non-fatal):', err.message || err);
  });

  timer = setInterval(() => {
    syncAgingStock().catch(err => {
      logger.error('[AgingSync] Scheduled sync error (non-fatal):', err.message || err);
    });
  }, SYNC_INTERVAL_MS);
}

function stopAgingSyncJob() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('[AgingSync] Scheduler stopped.');
}

module.exports = {
  syncAgingStock,
  startAgingSyncJob,
  stopAgingSyncJob,
};