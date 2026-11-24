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
 * Basis (2026-11-11): the inventory stores — Central Stores and F7 — each
 * on its own (one row per store per item, ReorderStatus.Store): its own
 * stock, and use = what leaves it (production, issues, transfers out —
 * stock.getStoreStockAndUse). Stock already issued to a department is
 * consumed for reordering and shown separately as HeldInDepartments (stock
 * outside both inventory stores), not counted as available.
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

/**
 * The critical levels set on each item in Busy (Item master → "Critical
 * Levels": minimum, reorder, maximum). Busy keeps them in Master1.D5 / D6 /
 * D7 — verified 2026-10-22 against Busy's own item XML (GetMasterXML) for
 * RM-0010, BNT Aroma Banana/Blueberry 500G and KOL Peeled Tomatoes 400G.
 * Items with none set are left out. (Busy also has per-store levels in the
 * item master; here they are tagged to accounts rather than stores, so
 * they are not used.)
 */
async function getBusyCriticalLevels(erpPool, itemCodes) {
  const ids = [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;
  const r = await erpPool.request().query(`
    SELECT Code, D5 AS MinLevel, D6 AS ReorderLevel, D7 AS MaxLevel FROM dbo.Master1
    WHERE MasterType = 6 AND Code IN (${ids.join(',')})
      AND (ISNULL(D5, 0) <> 0 OR ISNULL(D6, 0) <> 0 OR ISNULL(D7, 0) <> 0)`);
  for (const x of r.recordset) out.set(x.Code, { min: Number(x.MinLevel) || 0, reorder: Number(x.ReorderLevel) || 0, max: Number(x.MaxLevel) || 0 });
  return out;
}
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

/**
 * One Reorder Levels row for an item, from its stock and monthly use
 * (company-wide in the sync; one Mat Centre's stock and use in the store
 * view — see stock.service getStoreStockAndUse). null = not shown (finished
 * goods, services, or no stock and no use).
 */
function buildReorderRow(it, live, c, { eoq, price, last, busyLevels, boughtInputs }) {
  if (stock.isNonStock(it.group)) return null;
  // FG groups have their own page — except bought inputs misfiled there (stock.getBoughtInputs).
  if (stock.FG_GROUPS.has(String(it.group || '').toUpperCase()) && !boughtInputs?.has(it.itemCode)) return null;
  const hasConsumption = !!c && c.max6 > 0;
  if (Math.abs(live) < 0.0001 && !hasConsumption) return null;

  const lv = stock.computeLevels({ live, cons: c, leadWeeks: it.leadWeeks, eoq: eoq.get(it.itemCode) });
  const maxLevel = hasConsumption ? lv.maxLevel : null;
  const needsReorder = live <= lv.reorderLevel;
  const unitPrice = price.get(it.itemCode) ?? last.get(it.itemCode)?.price ?? null;
  const lastMonth = c ? [...c.months].reverse().find((m) => m.qty > 0) : null;

  const bl = busyLevels.get(it.itemCode) || null;
  return {
    ItemName: it.itemName,
    ItemGroup: it.group || 'NEEDS ITEM GROUP ASSIGNMENT',
    UOM: it.unitName ? String(it.unitName).slice(0, 20) : null,
    BusyMinLevel: bl ? r2(bl.min) : null,
    BusyReorderLevel: bl ? r2(bl.reorder) : null,
    BusyMaxLevel: bl ? r2(bl.max) : null,
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
  };
}

/**
 * Run a full reorder sync.
 * @returns {{ success: boolean, synced: number, needsReorder: number }}
 */
async function syncReorderStatus() {
  logger.info('[ReorderSync] Starting sync…');
  const [erpPool, localPool] = await Promise.all([getErpPool(), getPool()]);

  // Each inventory store on its own: its stock and what leaves it.
  const stores = [];
  for (const name of stock.INVENTORY_STORE_NAMES) {
    const s = await stock.getStoreStockAndUse(erpPool, name);
    if (s) stores.push(s); else logger.warn(`[ReorderSync] Inventory store "${name}" not found in Busy`);
  }
  if (!stores.length) throw new Error(`Inventory stores not found in Busy: ${stock.INVENTORY_STORE_NAMES.join(', ')}`);
  const invCodes = stores.map((s) => s.storeCode);

  // Stock already issued to departments = the item's stock outside the inventory stores.
  const byStore = await stock.getStockByStore(erpPool, null);
  const heldElsewhere = new Map();
  for (const [code, it] of byStore) {
    const q = it.stores.filter((s) => !s.excluded && !invCodes.includes(s.storeCode)).reduce((a, s) => a + s.qty, 0);
    if (Math.abs(q) > 0.0001) heldElsewhere.set(code, q);
  }

  const codesInStores = [...new Set(stores.flatMap((s) => [...s.stock.keys(), ...s.use.keys()]))];
  const items = await stock.resolveItems(erpPool, { itemCodes: codesInStores });
  const itemByCode = new Map(items.map((i) => [i.itemCode, i]));
  const codes = items.map((i) => i.itemCode);
  const fgCodes = items.filter((i) => stock.FG_GROUPS.has(String(i.group || '').toUpperCase())).map((i) => i.itemCode);
  const [eoq, price, last, busyLevels, boughtInputs] = await Promise.all([
    stock.getEoq(erpPool, codes),
    stock.getAvgInwardPrice(erpPool, codes),
    stock.getLastPurchase(erpPool, codes),
    getBusyCriticalLevels(erpPool, codes),
    stock.getBoughtInputs(erpPool, fgCodes),
  ]);

  const rows = [];
  for (const s of stores) {
    const storeCodes = new Set([...s.stock.keys(), ...s.use.keys()]);
    let n = 0;
    for (const code of storeCodes) {
      const it = itemByCode.get(code);
      if (!it) continue;
      const row = buildReorderRow(it, s.stock.get(code) ?? 0, s.use.get(code) || null, { eoq, price, last, busyLevels, boughtInputs });
      if (!row) continue;
      rows.push({ ...row, Store: s.storeName, HeldInDepartments: r2(heldElsewhere.get(code) ?? 0) });
      n++;
    }
    logger.info(`[ReorderSync] ${s.storeName}: ${n} item(s)`);
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
          UOM                   NVARCHAR(20)  '$.UOM',
          BusyMinLevel          FLOAT         '$.BusyMinLevel',
          BusyReorderLevel      FLOAT         '$.BusyReorderLevel',
          BusyMaxLevel          FLOAT         '$.BusyMaxLevel',
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
          StockValue            FLOAT         '$.StockValue',
          HeldInDepartments     FLOAT         '$.HeldInDepartments',
          Store                 NVARCHAR(80)  '$.Store'
        )
      ) AS source
        ON target.Store = source.Store AND target.ItemName = source.ItemName
      WHEN MATCHED THEN
        UPDATE SET
          ItemGroup = source.ItemGroup, UOM = source.UOM,
          BusyMinLevel = source.BusyMinLevel, BusyReorderLevel = source.BusyReorderLevel, BusyMaxLevel = source.BusyMaxLevel,
          LiveStock = source.LiveStock, ReorderLevel = source.ReorderLevel,
          MinimumStockLevel = source.MinimumStockLevel, MaxStockLevel = source.MaxStockLevel, EOQ = source.EOQ,
          LeadTime = source.LeadTime, LeadTimeDays = source.LeadTimeDays, BusyMonthYear = source.BusyMonthYear,
          BusyDate = NULL, NeedsReorder = source.NeedsReorder, RequiredQty = ISNULL(source.RequiredQty, 0),
          Overstocked = source.Overstocked, AvgMonthlyConsumption = source.AvgMonthlyConsumption,
          MonthsOfSupply = source.MonthsOfSupply, StockValue = source.StockValue,
          HeldInDepartments = source.HeldInDepartments,
          SyncedAt = SYSUTCDATETIME()
          -- AcknowledgedByUserId / AcknowledgedAt / AcknowledgedNotes and the snapshot: NOT touched
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (Store, ItemName, ItemGroup, UOM, BusyMinLevel, BusyReorderLevel, BusyMaxLevel,
                LiveStock, ReorderLevel, MinimumStockLevel, MaxStockLevel, EOQ,
                LeadTime, LeadTimeDays, BusyMonthYear, NeedsReorder, RequiredQty, Overstocked,
                AvgMonthlyConsumption, MonthsOfSupply, StockValue, HeldInDepartments, SyncedAt)
        VALUES (source.Store, source.ItemName, source.ItemGroup, source.UOM, source.BusyMinLevel, source.BusyReorderLevel, source.BusyMaxLevel,
                source.LiveStock, source.ReorderLevel, source.MinimumStockLevel,
                source.MaxStockLevel, source.EOQ, source.LeadTime, source.LeadTimeDays, source.BusyMonthYear,
                source.NeedsReorder, ISNULL(source.RequiredQty, 0), source.Overstocked,
                source.AvgMonthlyConsumption, source.MonthsOfSupply, source.StockValue, source.HeldInDepartments, SYSUTCDATETIME())
      WHEN NOT MATCHED BY SOURCE THEN
        DELETE;
    `);

  logger.info(`[ReorderSync] Done — ${synced} store item(s) synced, ${needsReorderCount} need reorder.`);
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
  buildReorderRow,
  getBusyCriticalLevels,
  syncReorderStatus,
  startReorderSyncJob,
  stopReorderSyncJob,
};
