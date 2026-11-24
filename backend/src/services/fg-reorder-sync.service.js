/**
 * Finished Goods Reorder Sync Service
 * Computes sales-velocity-driven stock status for finished goods.
 *
 * IMPORTANT — cross-server data flow:
 *   - Sales Report, FGProductGroupMap, FGGroupLeadTime; live stock from
 *     Tran4 + Tran2 (Itemwise_Stock until 2026-10-22, see CurrentStock)
 *     all live on the ERP server (njoro-server / BusyComp0006_db12026)
 *     -> queried via getErpPool()
 *   - FGReorderStatus (the synced results + Acknowledged* fields) lives
 *     on the LOCAL app database (MaterialTraceability) -> written via
 *     getPool(). This mirrors the raw-material reorder-sync.service.js
 *     pattern: pull/compute from ERP, MERGE into local.
 *
 * Formula (2026-10-22, same as the raw-material Reorder page), per product × store:
 *   sales window       the last 6 COMPLETE months; a month with no sales counts as 0
 *   max6 / min6        highest / lowest month with sales in those 6 months
 *   avg3               average of the last 3 complete months (zeros included)
 *   Reorder_Level      = max6 × LeadTimeMonths
 *   MinimumStockLevel  = (max6 − avg3) × LeadTimeMonths         (safety stock)
 *   MaximumStockLevel  = Reorder_Level + EOQ − min6 × LeadTimeMonths, never below Reorder_Level
 *                        (EOQ = average production run of the product, last 12 months)
 *   Overstocked        = LiveStock − MaximumStockLevel   (only when > 0)
 *   No sales in the 6 months → 'NO SALES LAST 6 MONTHS' (no levels, no false CRITICAL).
 * Replaced: max/min/avg over ALL sales history since May 2023 with no-sale
 * months ignored, and Maximum = (max − min) × lead — which put the maximum
 * below the reorder level on 73% of rows and made 1,096 rows CRITICAL.
 *
 * This service is detection/alerting only. It never creates production
 * orders or writes anything back to Busy ERP.
 */

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');

const FG_EXCLUDED_MATCENTERS = [
  'Admin', 'Transport', 'sales returns sylvia', 'Destruction', 'Cloakroom', 'FARM',
];

// Format a number as a fixed-decimal string (avoids JS exponential notation,
// e.g. 1.23e-7, which OPENJSON -> DECIMAL cannot parse and previously caused
// "Error converting data type nvarchar to decimal").
function toFixedStr(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n.toFixed(decimals);
}

async function syncFGReorderStatus() {
  logger.info('[FGReorderSync] Starting sync…');

  const erpPool = await getErpPool();
  const localPool = await getPool();

  // ── 1. Pull + compute everything from the ERP server ───────────────────────
  let rows;
  try {
    const excludeParams = FG_EXCLUDED_MATCENTERS
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(',');

    // Reads Busy's live stock tables while Busy users save; SQL Server can pick
    // this read as a deadlock victim (error 1205, seen 2026-10-22) — retry.
    const runQuery = async (text) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await erpPool.request().query(text);
        } catch (e) {
          if (e.number !== 1205 || attempt >= 3) throw e;
          logger.warn(`[FGReorderSync] Busy read was a deadlock victim — retrying (${attempt})`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    };
    // READ UNCOMMITTED: this dashboard read takes no shared locks on Busy's
    // stock tables, so it can neither block Busy users saving vouchers nor
    // be chosen as their deadlock victim (it lost 3 retries in a row on
    // 2026-10-22). At worst a voucher being saved that instant is missed
    // until the next hourly sync.
    const result = await runQuery(`
      SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
      WITH Win AS (
        SELECT DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AS ThisMonth
      ),
      -- Every product × store ever sold (kept listed even with no recent sales).
      ProductStores AS (
        SELECT DISTINCT UPPER(LTRIM(RTRIM(REPLACE(product, '-', ' ')))) AS NormName, Matcenter
        FROM dbo.[Sales Report]
        WHERE Matcenter NOT IN (${excludeParams})
      ),
      -- Net sales per month, last 6 complete months only.
      MonthlySales AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(product, '-', ' ')))) AS NormName,
          Matcenter,
          DATEFROMPARTS(YEAR(Date), MONTH(Date), 1) AS MonthStart,
          SUM(Qty) AS MonthlyQty
        FROM dbo.[Sales Report] CROSS JOIN Win
        WHERE Matcenter NOT IN (${excludeParams})
          AND Date >= DATEADD(month, -6, Win.ThisMonth) AND Date < Win.ThisMonth
        GROUP BY UPPER(LTRIM(RTRIM(REPLACE(product, '-', ' ')))), Matcenter, DATEFROMPARTS(YEAR(Date), MONTH(Date), 1)
      ),
      SalesStats AS (
        SELECT
          ps.NormName, ps.Matcenter,
          ISNULL(MAX(CASE WHEN ms.MonthlyQty > 0 THEN ms.MonthlyQty END), 0) AS MaxQty,
          ISNULL(MIN(CASE WHEN ms.MonthlyQty > 0 THEN ms.MonthlyQty END), 0) AS MinQty,
          -- months with no sales count as 0 in the 3-month average
          ISNULL(SUM(CASE WHEN ms.MonthStart >= DATEADD(month, -3, Win.ThisMonth) AND ms.MonthlyQty > 0
                          THEN CAST(ms.MonthlyQty AS DECIMAL(18,4)) END), 0) / 3.0 AS AvgQty
        FROM ProductStores ps CROSS JOIN Win
        LEFT JOIN MonthlySales ms ON ms.NormName = ps.NormName AND ms.Matcenter = ps.Matcenter
        GROUP BY ps.NormName, ps.Matcenter
      ),
      -- EOQ: the product's average production run (Production vouchers, last 12 months).
      ProductionRun AS (
        SELECT UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' ')))) AS NormName, AVG(t.Value1) AS AvgRun
        FROM dbo.Tran2 t JOIN dbo.Master1 i ON i.Code = t.MasterCode1 AND i.MasterType = 6
        WHERE t.RecType = 2 AND t.VchType = 6 AND t.Value1 > 0 AND t.[Date] >= DATEADD(month, -12, GETDATE())
        GROUP BY UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' '))))
      ),
      ProductGroupDedup AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(ProductName, '-', ' ')))) AS NormName,
          ItemGroup,
          ROW_NUMBER() OVER (
            PARTITION BY UPPER(LTRIM(RTRIM(REPLACE(ProductName, '-', ' '))))
            ORDER BY ItemGroup
          ) AS rn
        FROM dbo.FGProductGroupMap
      ),
      ProductGroup AS (
        SELECT NormName, ItemGroup FROM ProductGroupDedup WHERE rn = 1
      ),
      LeadTimeDedup AS (
        SELECT
          LTRIM(RTRIM(ItemGroup)) AS ItemGroupClean,
          LeadTimeMonths,
          ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(ItemGroup)) ORDER BY LeadTimeMonths) AS rn
        FROM dbo.FGGroupLeadTime
      ),
      LeadTime AS (
        SELECT ItemGroupClean, LeadTimeMonths FROM LeadTimeDedup WHERE rn = 1
      ),
      -- Live stock per product per store, computed the way stock.service.js
      -- does (verified against Busy's own closing balances): Tran4 opening +
      -- every Tran2 stock movement. Replaces Busy's custom Itemwise_Stock
      -- view (2026-10-22), which dropped items with movements but no opening
      -- row — 1,604 of 1,878 FG rows had no stock and showed "NEEDS STOCK
      -- MASTER REVIEW".
      StockRows AS (
        SELECT MasterCode1 AS ItemCode, MasterCode2 AS StoreCode, SUM(D1) AS Qty
        FROM dbo.Tran4 WHERE MasterCode2 <> 0 GROUP BY MasterCode1, MasterCode2
        UNION ALL
        SELECT MasterCode1, MasterCode2, SUM(Value1)
        FROM dbo.Tran2 WHERE RecType = 2 GROUP BY MasterCode1, MasterCode2
      ),
      CurrentStock AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' ')))) AS NormName,
          UPPER(LTRIM(RTRIM(mc.Name))) AS factory,
          SUM(s.Qty) AS LiveStock
        FROM StockRows s
        JOIN dbo.Master1 i  ON i.Code = s.ItemCode AND i.MasterType = 6
        JOIN dbo.Master1 mc ON mc.Code = s.StoreCode AND mc.MasterType = 11
        GROUP BY UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' ')))), UPPER(LTRIM(RTRIM(mc.Name)))
      ),
      -- The Busy item behind each product (same name normalisation): its unit
      -- and the critical levels set on it in Busy — Master1.D5 = minimum,
      -- D6 = reorder, D7 = maximum (verified 2026-10-22 via Busy's item XML).
      ItemMasterDedup AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' ')))) AS NormName,
          LTRIM(RTRIM(u.Name)) AS UOM, i.D5 AS BusyMin, i.D6 AS BusyReorder, i.D7 AS BusyMax,
          ROW_NUMBER() OVER (PARTITION BY UPPER(LTRIM(RTRIM(REPLACE(i.Name, '-', ' ')))) ORDER BY i.Code) AS rn
        FROM dbo.Master1 i LEFT JOIN dbo.Master1 u ON u.Code = i.CM1
        WHERE i.MasterType = 6
      )
      SELECT
        ss.NormName, ss.Matcenter, pg.ItemGroup, lt.LeadTimeMonths AS LeadTime,
        im.UOM,
        CASE WHEN ISNULL(im.BusyMin, 0) <> 0 OR ISNULL(im.BusyReorder, 0) <> 0 OR ISNULL(im.BusyMax, 0) <> 0 THEN im.BusyMin END AS BusyMinLevel,
        CASE WHEN ISNULL(im.BusyMin, 0) <> 0 OR ISNULL(im.BusyReorder, 0) <> 0 OR ISNULL(im.BusyMax, 0) <> 0 THEN im.BusyReorder END AS BusyReorderLevel,
        CASE WHEN ISNULL(im.BusyMin, 0) <> 0 OR ISNULL(im.BusyReorder, 0) <> 0 OR ISNULL(im.BusyMax, 0) <> 0 THEN im.BusyMax END AS BusyMaxLevel,
        lv.ReorderLevel AS Reorder_Level,
        lv.MinLevel AS MinimumStockLevel,
        lv.MaxLevel AS MaximumStockLevel,
        st.LiveStock,
        CASE
          WHEN pg.ItemGroup IS NULL THEN 'NEEDS GROUP ASSIGNMENT'
          WHEN lt.LeadTimeMonths IS NULL THEN 'NEEDS LEAD TIME ASSIGNMENT'
          WHEN st.LiveStock IS NULL THEN 'NEEDS STOCK MASTER REVIEW'
          WHEN ss.MaxQty = 0 THEN 'NO SALES LAST 6 MONTHS'
          WHEN st.LiveStock <= lv.MinLevel THEN 'CRITICAL'
          WHEN st.LiveStock <= lv.ReorderLevel THEN 'REORDER'
          ELSE 'OK'
        END AS StockStatus,
        CASE
          WHEN lt.LeadTimeMonths IS NULL OR st.LiveStock IS NULL OR ss.MaxQty = 0 THEN NULL
          WHEN st.LiveStock > lv.MaxLevel THEN st.LiveStock - lv.MaxLevel
          ELSE 0
        END AS Overstocked
      FROM SalesStats ss
      LEFT JOIN ProductGroup pg ON pg.NormName = ss.NormName
      LEFT JOIN LeadTime lt     ON lt.ItemGroupClean = pg.ItemGroup
      LEFT JOIN ItemMasterDedup im ON im.NormName = ss.NormName AND im.rn = 1
      LEFT JOIN ProductionRun pr ON pr.NormName = ss.NormName
      LEFT JOIN CurrentStock cs ON cs.NormName = ss.NormName AND cs.factory = UPPER(LTRIM(RTRIM(ss.Matcenter)))
      -- A product that exists in Busy but has no stock rows in this store
      -- has 0 there; only a product with no Busy item at all stays unknown.
      CROSS APPLY (SELECT CASE WHEN cs.LiveStock IS NOT NULL THEN cs.LiveStock
                               WHEN im.NormName IS NOT NULL THEN 0 END AS LiveStock) st
      -- The levels (NULL without a lead time).
      CROSS APPLY (SELECT ss.MaxQty * lt.LeadTimeMonths AS ReorderLevel,
                          CASE WHEN (ss.MaxQty - ss.AvgQty) * lt.LeadTimeMonths > 0
                               THEN (ss.MaxQty - ss.AvgQty) * lt.LeadTimeMonths ELSE 0 END AS MinLevel) l1
      CROSS APPLY (SELECT l1.ReorderLevel AS ReorderLevel, l1.MinLevel AS MinLevel,
                          CASE WHEN l1.ReorderLevel + ISNULL(pr.AvgRun, 0) - ss.MinQty * lt.LeadTimeMonths > l1.ReorderLevel
                               THEN l1.ReorderLevel + ISNULL(pr.AvgRun, 0) - ss.MinQty * lt.LeadTimeMonths
                               ELSE l1.ReorderLevel END AS MaxLevel) lv
    `);
    rows = result.recordset;
  } catch (err) {
    logger.error('[FGReorderSync] ERP query failed:', err);
    throw err;
  }

  logger.info(`[FGReorderSync] ERP query returned ${rows.length} item(s)`);

  if (rows.length === 0) {
    logger.warn('[FGReorderSync] No rows returned — skipping MERGE');
    return { success: true, synced: 0 };
  }

  // Numeric fields are serialized as fixed-decimal strings (not raw JS
  // numbers) so that JSON.stringify never emits exponential notation
  // (e.g. 1.23e-7), which OPENJSON -> DECIMAL(...) cannot parse.
  const cleanRows = rows
    .map(r => ({
      ItemName:          String(r.NormName || '').trim() || null,
      Factory:            String(r.Matcenter || '').trim() || null,
      ItemGroup:          r.ItemGroup ? String(r.ItemGroup).trim() : null,
      LeadTime:           toFixedStr(r.LeadTime, 2),
      ReorderLevel:       toFixedStr(r.Reorder_Level, 2),
      MinimumStockLevel:  toFixedStr(r.MinimumStockLevel, 2),
      MaximumStockLevel:  toFixedStr(r.MaximumStockLevel, 2),
      LiveStock:          toFixedStr(r.LiveStock, 2),
      StockStatus:        r.StockStatus,
      Overstocked:        toFixedStr(r.Overstocked, 2),
      UOM:                r.UOM ? String(r.UOM).slice(0, 20) : null,
      BusyMinLevel:       toFixedStr(r.BusyMinLevel, 2),
      BusyReorderLevel:   toFixedStr(r.BusyReorderLevel, 2),
      BusyMaxLevel:       toFixedStr(r.BusyMaxLevel, 2),
    }))
    .filter(r => r.ItemName && r.Factory);

  const synced = cleanRows.length;

  // ── 2. MERGE into the LOCAL app database ────────────────────────────────
  try {
    await localPool.request()
      .input('jsonData', sql.NVarChar(sql.MAX), JSON.stringify(cleanRows))
      .query(`
        MERGE dbo.FGReorderStatus AS target
        USING (
          SELECT
            j.ItemName, j.Factory, j.ItemGroup, j.LeadTime,
            j.ReorderLevel, j.MinimumStockLevel, j.MaximumStockLevel,
            j.LiveStock, j.StockStatus, j.Overstocked,
            j.UOM, j.BusyMinLevel, j.BusyReorderLevel, j.BusyMaxLevel
          FROM OPENJSON(@jsonData) WITH (
            ItemName          NVARCHAR(200) '$.ItemName',
            Factory           NVARCHAR(80)  '$.Factory',
            ItemGroup         NVARCHAR(50)  '$.ItemGroup',
            LeadTime          DECIMAL(5,2)  '$.LeadTime',
            ReorderLevel      DECIMAL(14,2) '$.ReorderLevel',
            MinimumStockLevel DECIMAL(14,2) '$.MinimumStockLevel',
            MaximumStockLevel DECIMAL(14,2) '$.MaximumStockLevel',
            LiveStock         DECIMAL(14,2) '$.LiveStock',
            StockStatus       NVARCHAR(30)  '$.StockStatus',
            Overstocked       DECIMAL(14,2) '$.Overstocked',
            UOM               NVARCHAR(20)  '$.UOM',
            BusyMinLevel      DECIMAL(14,2) '$.BusyMinLevel',
            BusyReorderLevel  DECIMAL(14,2) '$.BusyReorderLevel',
            BusyMaxLevel      DECIMAL(14,2) '$.BusyMaxLevel'
          ) j
        ) AS source
          ON  target.ItemName = source.ItemName
          AND target.Factory  = source.Factory
        WHEN MATCHED THEN
          UPDATE SET
            ItemGroup         = source.ItemGroup,
            LeadTime          = source.LeadTime,
            ReorderLevel      = source.ReorderLevel,
            MinimumStockLevel = source.MinimumStockLevel,
            MaximumStockLevel = source.MaximumStockLevel,
            LiveStock         = source.LiveStock,
            StockStatus       = source.StockStatus,
            Overstocked       = source.Overstocked,
            UOM               = source.UOM,
            BusyMinLevel      = source.BusyMinLevel,
            BusyReorderLevel  = source.BusyReorderLevel,
            BusyMaxLevel      = source.BusyMaxLevel,
            SyncedAt          = SYSUTCDATETIME()
            -- AcknowledgedByUserId, AcknowledgedAt, AcknowledgedNotes: NOT touched
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (
            ItemName, Factory, ItemGroup, LeadTime,
            ReorderLevel, MinimumStockLevel, MaximumStockLevel,
            LiveStock, StockStatus, Overstocked, UOM, BusyMinLevel, BusyReorderLevel, BusyMaxLevel, SyncedAt
          )
          VALUES (
            source.ItemName, source.Factory, source.ItemGroup, source.LeadTime,
            source.ReorderLevel, source.MinimumStockLevel, source.MaximumStockLevel,
            source.LiveStock, source.StockStatus, source.Overstocked,
            source.UOM, source.BusyMinLevel, source.BusyReorderLevel, source.BusyMaxLevel,
            SYSUTCDATETIME()
          )
        -- Product × store rows the sync no longer produces (16 left over from
        -- July–October on 2026-10-22, showing stale levels) are removed, as in
        -- the raw-material reorder sync.
        WHEN NOT MATCHED BY SOURCE THEN
          DELETE;
      `);
  } catch (mergeErr) {
    logger.error('[FGReorderSync] Local MERGE failed:', mergeErr);
    throw mergeErr;
  }

  logger.info(`[FGReorderSync] Done — ${synced} row(s) synced.`);
  return { success: true, synced };
}

const FG_REORDER_SYNC_INTERVAL_MS =
  parseInt(process.env.FG_REORDER_SYNC_INTERVAL_MS, 10) || 60 * 60 * 1000;

let _fgReorderSyncTimer = null;

function startFGReorderSyncJob() {
  if (_fgReorderSyncTimer) return;
  logger.info(
    `[FGReorderSync] Background job started (every ${FG_REORDER_SYNC_INTERVAL_MS / 60000} min)`
  );
  syncFGReorderStatus().catch(err =>
    logger.error('[FGReorderSync] Startup sync error (non-fatal):', err.message)
  );
  _fgReorderSyncTimer = setInterval(() => {
    syncFGReorderStatus().catch(err =>
      logger.error('[FGReorderSync] Scheduled sync error (non-fatal):', err.message)
    );
  }, FG_REORDER_SYNC_INTERVAL_MS);
}

function stopFGReorderSyncJob() {
  if (_fgReorderSyncTimer) {
    clearInterval(_fgReorderSyncTimer);
    _fgReorderSyncTimer = null;
    logger.info('[FGReorderSync] Background job stopped.');
  }
}

module.exports = { syncFGReorderStatus, startFGReorderSyncJob, stopFGReorderSyncJob };