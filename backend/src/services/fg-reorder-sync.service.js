/**
 * Finished Goods Reorder Sync Service
 * Computes sales-velocity-driven stock status for finished goods.
 *
 * IMPORTANT — cross-server data flow:
 *   - Sales Report, Itemwise_Stock, FGProductGroupMap, FGGroupLeadTime
 *     all live on the ERP server (njoro-server / BusyComp0006_db12026)
 *     -> queried via getErpPool()
 *   - FGReorderStatus (the synced results + Acknowledged* fields) lives
 *     on the LOCAL app database (MaterialTraceability) -> written via
 *     getPool(). This mirrors the raw-material reorder-sync.service.js
 *     pattern: pull/compute from ERP, MERGE into local.
 *
 * Formula (lead-time based, same shape as raw materials):
 *   Reorder_Level      = MaxMonthlySales × LeadTimeMonths
 *   MinimumStockLevel  = Reorder_Level − (AvgMonthlySales × LeadTimeMonths)
 *   MaximumStockLevel  = Reorder_Level − (MinMonthlySales × LeadTimeMonths)
 *   Overstocked        = MaximumStockLevel − LiveStock   (only meaningful when > 0)
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

    const result = await erpPool.request().query(`
      WITH MonthlySales AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(product, '-', ' ')))) AS NormName,
          Matcenter,
          FORMAT(Date, 'yyyyMM') AS MonthYear,
          SUM(Qty) AS MonthlyQty
        FROM dbo.[Sales Report]
        WHERE Matcenter NOT IN (${excludeParams})
        GROUP BY UPPER(LTRIM(RTRIM(REPLACE(product, '-', ' ')))), Matcenter, FORMAT(Date, 'yyyyMM')
      ),
      SalesStats AS (
        SELECT
          NormName, Matcenter,
          MIN(MonthlyQty) AS MinQty,
          AVG(CAST(MonthlyQty AS DECIMAL(18,2))) AS AvgQty,
          MAX(MonthlyQty) AS MaxQty
        FROM MonthlySales
        GROUP BY NormName, Matcenter
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
      CurrentStock AS (
        SELECT
          UPPER(LTRIM(RTRIM(REPLACE(Name, '-', ' ')))) AS NormName,
          factory,
          SUM(currentstock) AS LiveStock
        FROM dbo.Itemwise_Stock
        GROUP BY UPPER(LTRIM(RTRIM(REPLACE(Name, '-', ' ')))), factory
      )
      SELECT
        ss.NormName, ss.Matcenter, pg.ItemGroup, lt.LeadTimeMonths AS LeadTime,
        ss.MaxQty * lt.LeadTimeMonths AS Reorder_Level,
        (ss.MaxQty * lt.LeadTimeMonths) - (ss.AvgQty * lt.LeadTimeMonths) AS MinimumStockLevel,
        (ss.MaxQty * lt.LeadTimeMonths) - (ss.MinQty * lt.LeadTimeMonths) AS MaximumStockLevel,
        st.LiveStock,
        CASE
          WHEN pg.ItemGroup IS NULL THEN 'NEEDS GROUP ASSIGNMENT'
          WHEN lt.LeadTimeMonths IS NULL THEN 'NEEDS LEAD TIME ASSIGNMENT'
          WHEN st.LiveStock IS NULL THEN 'NEEDS STOCK MASTER REVIEW'
          WHEN st.LiveStock <= (ss.MaxQty * lt.LeadTimeMonths) - (ss.AvgQty * lt.LeadTimeMonths) THEN 'CRITICAL'
          WHEN st.LiveStock <= ss.MaxQty * lt.LeadTimeMonths THEN 'REORDER'
          ELSE 'OK'
        END AS StockStatus,
        CASE
          WHEN lt.LeadTimeMonths IS NULL OR st.LiveStock IS NULL THEN NULL
          ELSE (SELECT MAX(v) FROM (VALUES
            (st.LiveStock - ((ss.MaxQty * lt.LeadTimeMonths) - (ss.MinQty * lt.LeadTimeMonths))),
            (0)
          ) AS x(v))
        END AS Overstocked
      FROM SalesStats ss
      LEFT JOIN ProductGroup pg ON pg.NormName = ss.NormName
      LEFT JOIN LeadTime lt     ON lt.ItemGroupClean = pg.ItemGroup
      LEFT JOIN CurrentStock st ON st.NormName = ss.NormName AND st.factory = ss.Matcenter
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
            j.LiveStock, j.StockStatus, j.Overstocked
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
            Overstocked       DECIMAL(14,2) '$.Overstocked'
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
            SyncedAt          = SYSUTCDATETIME()
            -- AcknowledgedByUserId, AcknowledgedAt, AcknowledgedNotes: NOT touched
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (
            ItemName, Factory, ItemGroup, LeadTime,
            ReorderLevel, MinimumStockLevel, MaximumStockLevel,
            LiveStock, StockStatus, Overstocked, SyncedAt
          )
          VALUES (
            source.ItemName, source.Factory, source.ItemGroup, source.LeadTime,
            source.ReorderLevel, source.MinimumStockLevel, source.MaximumStockLevel,
            source.LiveStock, source.StockStatus, source.Overstocked,
            SYSUTCDATETIME()
          );
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