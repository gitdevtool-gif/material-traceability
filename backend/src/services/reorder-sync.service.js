/**
 * Reorder Sync Service
 *
 * Rebuilt 2026-10-17 on services/stock.service.js instead of Busy's custom
 * dbo.reorder view, which was verified wrong (see stock.service.js header):
 * its live stock dropped 580 items and zeroed 3,911 more, it only counted
 * production as consumption (so stores items showed "no consumption
 * history"), items with no LeadTime row got lead time 0 → reorder level 0,
 * and this sync wrote the lead time in MONTHS into LeadTimeDays and never
 * filled AvgMonthlyConsumption / MonthsOfSupply / StockValue.
 *
 * Rules kept exactly as confirmed with the business owner:
 *   NeedsReorder = LiveStock <= ReorderLevel   (negative LiveStock is valid)
 *   RequiredQty  = MAX(0, MaxStockLevel - LiveStock)
 *   Overstocked  = MAX(0, LiveStock - MaxStockLevel), NULL with no consumption
 * Reorder / minimum / maximum levels use the same formulas as dbo.reorder,
 * on corrected consumption and with a 3-week default lead time (see
 * stock.service.js).
 *
 * Items listed: every raw-material/stores item (finished-goods and WIP
 * groups excluded — they have the FG reorder page) that has stock or
 * consumption. Rows for items no longer listed are removed (nothing
 * references ReorderStatus rows; acknowledgements on listed items are kept).
 *
 * Detection only — never writes to Busy.
 */
const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');
const stock = require('./stock.service');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

/**
 * Run a full reorder sync.
 * @returns {{ success: boolean, synced: number, needsReorder: number }}
 */
async function syncReorderStatus() {
  logger.info('[ReorderSync] Starting sync…');
  const [erpPool, localPool] = await Promise.all([getErpPool(), getPool()]);

  const byStore = await stock.getStockByStore(erpPool, null);
  // Every item with any stock row, plus every item consumed recently.
  const allCodesResult = await erpPool.request().query(`
    SELECT DISTINCT MasterCode1 AS Code FROM dbo.Tran2
    WHERE RecType = 2 AND VchType IN (5, 6, 11) AND [Date] >= DATEADD(month, -7, GETDATE())`);
  const candidateCodes = [...new Set([...byStore.keys(), ...allCodesResult.recordset.map((r) => r.Code)])];
  const items = await stock.resolveItems(erpPool, { itemCodes: candidateCodes });
  const nameByCode = new Map(items.map((i) => [i.itemCode, i.itemName]));
  const codes = items.map((i) => i.itemCode);

  const [cons, eoq, price, last] = await Promise.all([
    stock.getConsumption(erpPool, codes, { nameByCode }),
    stock.getEoq(erpPool, codes),
    stock.getAvgInwardPrice(erpPool, codes),
    stock.getLastPurchase(erpPool, codes),
  ]);
  logger.info(`[ReorderSync] Busy: ${items.length} item(s), ${[...cons.values()].filter((c) => c.avg3 > 0).length} with consumption`);

  const rows = [];
  for (const it of items) {
    if (stock.FG_GROUPS.has(String(it.group || '').toUpperCase()) || stock.isNonStock(it.group)) continue;
    const live = byStore.get(it.itemCode)?.total ?? 0;
    const c = cons.get(it.itemCode) || null;
    const hasConsumption = !!c && c.max6 > 0;
    if (Math.abs(live) < 0.0001 && !hasConsumption) continue;

    const lv = stock.computeLevels({ live, cons: c, leadWeeks: it.leadWeeks, eoq: eoq.get(it.itemCode) });
    const maxLevel = hasConsumption ? lv.maxLevel : null;
    const needsReorder = live <= lv.reorderLevel;
    const unitPrice = price.get(it.itemCode) ?? last.get(it.itemCode)?.price ?? null;
    const lastMonth = c ? [...c.months].reverse().find((m) => m.qty > 0) : null;

    rows.push({
      ItemName: it.itemName,
      ItemGroup: it.group || 'NEEDS ITEM GROUP ASSIGNMENT',
      LiveStock: r2(live),
      ReorderLevel: r2(lv.reorderLevel),
      MinimumStockLevel: r2(lv.minLevel),
      MaxStockLevel: r2(maxLevel),
      EOQ: r2(eoq.get(it.itemCode) ?? 0),
      LeadTime: r2(it.leadWeeks),            // weeks
      LeadTimeDays: r2(it.leadWeeks * 7),    // days (the Reorder page labels this column "days")
      BusyMonthYear: lastMonth ? `${MONTH_NAMES[Number(lastMonth.month.slice(5)) - 1]}-${lastMonth.month.slice(0, 4)}` : null,
      NeedsReorder: needsReorder ? 1 : 0,
      RequiredQty: maxLevel === null ? null : r2(Math.max(0, maxLevel - live)),
      Overstocked: maxLevel === null ? null : r2(Math.max(0, live - maxLevel)),
      AvgMonthlyConsumption: hasConsumption ? r2(c.avg3) : null,
      MonthsOfSupply: hasConsumption && c.avg3 > 0 ? r2(live / c.avg3) : null,
      StockValue: unitPrice != null ? r2(live * unitPrice) : null,
    });
  }

  const synced = rows.length;
  const needsReorderCount = rows.filter((r) => r.NeedsReorder === 1).length;
  if (synced === 0) {
    logger.warn('[ReorderSync] Nothing computed from Busy — skipping MERGE (existing rows left as they are)');
    return { success: true, synced: 0, needsReorder: 0 };
  }

  await localPool.request()
    .input('jsonData', sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(`
      MERGE dbo.ReorderStatus AS target
      USING (
        SELECT * FROM OPENJSON(@jsonData) WITH (
          ItemName              NVARCHAR(200) '$.ItemName',
          ItemGroup             NVARCHAR(80)  '$.ItemGroup',
          LiveStock             FLOAT         '$.LiveStock',
          ReorderLevel          FLOAT         '$.ReorderLevel',
          MinimumStockLevel     FLOAT         '$.MinimumStockLevel',
          MaxStockLevel         FLOAT         '$.MaxStockLevel',
          EOQ                   FLOAT         '$.EOQ',
          LeadTime              DECIMAL(5,2)  '$.LeadTime',
          LeadTimeDays          DECIMAL(9,2)  '$.LeadTimeDays',
          BusyMonthYear         NVARCHAR(20)  '$.BusyMonthYear',
          NeedsReorder          BIT           '$.NeedsReorder',
          RequiredQty           FLOAT         '$.RequiredQty',
          Overstocked           FLOAT         '$.Overstocked',
          AvgMonthlyConsumption FLOAT         '$.AvgMonthlyConsumption',
          MonthsOfSupply        FLOAT         '$.MonthsOfSupply',
          StockValue            FLOAT         '$.StockValue'
        )
      ) AS source
        ON target.ItemName = source.ItemName
      WHEN MATCHED THEN
        UPDATE SET
          ItemGroup = source.ItemGroup, LiveStock = source.LiveStock, ReorderLevel = source.ReorderLevel,
          MinimumStockLevel = source.MinimumStockLevel, MaxStockLevel = source.MaxStockLevel, EOQ = source.EOQ,
          LeadTime = source.LeadTime, LeadTimeDays = source.LeadTimeDays, BusyMonthYear = source.BusyMonthYear,
          BusyDate = NULL, NeedsReorder = source.NeedsReorder, RequiredQty = ISNULL(source.RequiredQty, 0),
          Overstocked = source.Overstocked, AvgMonthlyConsumption = source.AvgMonthlyConsumption,
          MonthsOfSupply = source.MonthsOfSupply, StockValue = source.StockValue,
          SyncedAt = SYSUTCDATETIME()
          -- AcknowledgedByUserId / AcknowledgedAt / AcknowledgedNotes and the snapshot: NOT touched
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (ItemName, ItemGroup, LiveStock, ReorderLevel, MinimumStockLevel, MaxStockLevel, EOQ,
                LeadTime, LeadTimeDays, BusyMonthYear, NeedsReorder, RequiredQty, Overstocked,
                AvgMonthlyConsumption, MonthsOfSupply, StockValue, SyncedAt)
        VALUES (source.ItemName, source.ItemGroup, source.LiveStock, source.ReorderLevel, source.MinimumStockLevel,
                source.MaxStockLevel, source.EOQ, source.LeadTime, source.LeadTimeDays, source.BusyMonthYear,
                source.NeedsReorder, ISNULL(source.RequiredQty, 0), source.Overstocked,
                source.AvgMonthlyConsumption, source.MonthsOfSupply, source.StockValue, SYSUTCDATETIME())
      WHEN NOT MATCHED BY SOURCE THEN
        DELETE;
    `);

  logger.info(`[ReorderSync] Done — ${synced} item(s) synced, ${needsReorderCount} need reorder.`);
  return { success: true, synced, needsReorder: needsReorderCount };
}

// ── Background polling job ──────────────────────────────────────────────────
// Default: every 60 minutes. Override with env var REORDER_SYNC_INTERVAL_MS.
const SYNC_INTERVAL_MS =
  parseInt(process.env.REORDER_SYNC_INTERVAL_MS, 10) || 60 * 60 * 1000;

let timer = null;

function startReorderSyncJob() {
  if (timer) return; // already running

  logger.info(`[ReorderSync] Scheduler started. Interval = ${SYNC_INTERVAL_MS / 1000}s`);

  syncReorderStatus().catch(err => {
    logger.error('[ReorderSync] Startup sync error (non-fatal):', err.message || err);
  });

  timer = setInterval(() => {
    syncReorderStatus().catch(err => {
      logger.error('[ReorderSync] Scheduled sync error (non-fatal):', err.message || err);
    });
  }, SYNC_INTERVAL_MS);
}

function stopReorderSyncJob() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('[ReorderSync] Scheduler stopped.');
}

module.exports = {
  syncReorderStatus,
  startReorderSyncJob,
  stopReorderSyncJob,
};
