/**
 * Stock engine (2026-10-17) — one read-only source for live stock, batch
 * balances, monthly consumption and reorder levels, computed straight from
 * Busy's tables. Replaces the custom Busy views this system used before
 * (dbo.reorder → Itemwise_Stock → Open_Stock/Stock_mvmt, BatchwiseStock),
 * which were verified wrong on 2026-10-17:
 *   - Itemwise_Stock started from opening stock and LEFT JOINed movements:
 *     580 items with movement but no opening row vanished, and 3,911 items
 *     with opening stock but no movement showed NULL → 0.
 *   - Open_Stock summed every Tran4 row, including supplier/ledger opening
 *     BALANCES (e.g. C. CZARNIKOW SUGAR 6,737,000.54), not just items.
 *   - BatchwiseStock grouped by quantity and price (Value1/Value3) with no
 *     RecType filter: issues never netted against their batch, and every
 *     GRN batch appeared twice (store row + the supplier's challan row).
 *
 * Verified against Busy's own figure (COM GetItemMCClosingBals) on 8 item ×
 * store pairs — exact match:
 *   stock(item, store) = Tran4 opening (items, store <> 0)
 *                      + SUM(Tran2.Value1) over stock rows (RecType 2)
 *
 * Company stock excludes "Materials Consumable" (store 12265), as the old
 * views did: goods transferred there are treated as consumed.
 *
 * Monthly consumption (company-wide, per calendar month) =
 *     raw material used in production   (Production, VchType 6, outflows)
 *   + goods issued to a party            (VchType 11 outflows, except the
 *                                         "Pur-return" series = returns to supplier)
 *   + net stock transfers out of stock   (VchType 5 — store-to-store moves
 *                                         cancel; a move into the consumable
 *                                         store is consumption)
 * Previous financial year's database is read for months before 1 May.
 *
 * Reorder figures use the same formulas as the old dbo.reorder view, with
 * lead time from dbo.LeadTime by item group and DEFAULT_LEAD_WEEKS (3) when
 * the group has none:
 *   lead (months) = weeks / 4
 *   reorder level = max monthly × lead
 *   minimum level = (max monthly − avg monthly) × lead
 *   maximum level = max monthly × lead + EOQ − min monthly × lead
 * where avg = last 3 complete months, max/min = last 6 complete months
 * (min over months with consumption), EOQ = average PO line qty this year.
 */
const { sql: erpSql } = require('../erpDb');

const EXCLUDED_STORES = String(process.env.BUSY_EXCLUDED_STORES || '12265')
  .split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
const DEFAULT_LEAD_WEEKS = Number(process.env.DEFAULT_LEAD_TIME_WEEKS) || 3;
const CENTRAL_STORES_NAME = process.env.BUSY_CENTRAL_STORES_NAME || 'CENTRAL STORES';
const PREV_FY_DB = process.env.BUSY_PREV_FY_DB || 'BusyComp0006_db12025';
if (!/^[A-Za-z0-9_]+$/.test(PREV_FY_DB)) throw new Error('BUSY_PREV_FY_DB must be a plain database name');

// Finished-goods / WIP groups — same list the old dbo.reorder view excluded
// from raw-material reorder (they have their own FG reorder page).
const FG_GROUPS = new Set([
  'F1 FINISHED PRODUCT', 'F1 WIP', 'F2 BULK GOODS', 'F2 FINISHED GOODS', 'F2 WIP', 'F3 BULK GOODS',
  'F3 FINSHED GOODS', 'F4 FINISHED GOODS', 'F5 FINISHED GOODS', 'F6 BULK STOCK', 'F6 FINISHED GOODS',
  'F9 BULK GOODS', 'F9 FINISHED GOODS', 'CENTRAL STORES FINISHED GOODS',
].map((g) => g.toUpperCase()));

// Services bought/sold through items (e.g. "Transport charges", -23,005
// "units") — no stock, so no reorder levels.
const NON_STOCK_GROUPS = new Set(String(process.env.BUSY_NON_STOCK_GROUPS || 'SERVICE ITEMS,SERVICE SALES')
  .split(',').map((g) => g.trim().toUpperCase()).filter(Boolean));
const isNonStock = (group) => NON_STOCK_GROUPS.has(String(group || '').toUpperCase());

const r2 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
const r3 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** `MasterCode1 IN (...)` filter for an optional item list (null = all items). */
function itemFilter(req, column, itemCodes) {
  if (!itemCodes) return '';
  if (itemCodes.length === 0) return ' AND 1 = 0';
  // Comma-joined integers are safe to inline and avoid the 2,100-parameter limit.
  const ids = [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))];
  return ids.length ? ` AND ${column} IN (${ids.join(',')})` : ' AND 1 = 0';
}
const excludedList = () => (EXCLUDED_STORES.length ? EXCLUDED_STORES.join(',') : '-1');

// ── Item masters ─────────────────────────────────────────────────────────────

/**
 * Busy items by code and/or exact name (trimmed, case-insensitive), with
 * unit, item group and the group's lead time.
 */
async function resolveItems(erpPool, { itemCodes = [], itemNames = [] } = {}) {
  const req = erpPool.request();
  const conds = [];
  const codes = [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))];
  if (codes.length) conds.push(`i.Code IN (${codes.join(',')})`);
  const names = [...new Set(itemNames.map((n) => String(n || '').trim()).filter(Boolean))];
  if (names.length) {
    names.forEach((n, k) => req.input(`n${k}`, erpSql.NVarChar(60), n.toUpperCase()));
    conds.push(`UPPER(LTRIM(RTRIM(i.Name))) IN (${names.map((_, k) => `@n${k}`).join(',')})`);
  }
  if (!conds.length) return [];
  const result = await req.query(`
    SELECT i.Code, LTRIM(RTRIM(i.Name)) AS Name, LTRIM(RTRIM(u.Name)) AS UnitName,
           LTRIM(RTRIM(g.Name)) AS GroupName, lt.leadtime_week AS LeadWeeks
    FROM dbo.Master1 i
    LEFT JOIN dbo.Master1 u ON u.Code = i.CM1
    LEFT JOIN dbo.Master1 g ON g.Code = i.ParentGrp
    LEFT JOIN dbo.LeadTime lt ON lt.category = g.Name
    WHERE i.MasterType = 6 AND (${conds.join(' OR ')})`);
  return result.recordset.map((r) => ({
    itemCode: r.Code,
    itemName: r.Name,
    unitName: r.UnitName,
    group: r.GroupName,
    leadWeeks: r.LeadWeeks != null ? Number(r.LeadWeeks) : DEFAULT_LEAD_WEEKS,
    leadDefaulted: r.LeadWeeks == null,
  }));
}

// ── Live stock ───────────────────────────────────────────────────────────────

/** Stock per item per store (opening + movements). itemCodes null = every item. */
async function getStockByStore(erpPool, itemCodes) {
  const req = erpPool.request();
  const result = await req.query(`
    WITH s AS (
      SELECT t.MasterCode1 AS ItemCode, t.MasterCode2 AS StoreCode, SUM(t.D1) AS Qty
      FROM dbo.Tran4 t JOIN dbo.Master1 i ON i.Code = t.MasterCode1 AND i.MasterType = 6
      WHERE t.MasterCode2 <> 0 ${itemFilter(req, 't.MasterCode1', itemCodes)}
      GROUP BY t.MasterCode1, t.MasterCode2
      UNION ALL
      SELECT t.MasterCode1, t.MasterCode2, SUM(t.Value1)
      FROM dbo.Tran2 t
      WHERE t.RecType = 2 ${itemFilter(req, 't.MasterCode1', itemCodes)}
      GROUP BY t.MasterCode1, t.MasterCode2
    )
    SELECT s.ItemCode, s.StoreCode, LTRIM(RTRIM(mc.Name)) AS Store, SUM(s.Qty) AS Qty
    FROM s JOIN dbo.Master1 mc ON mc.Code = s.StoreCode
    GROUP BY s.ItemCode, s.StoreCode, mc.Name
    HAVING ABS(SUM(s.Qty)) > 0.0001`);
  const byItem = new Map();
  for (const r of result.recordset) {
    let it = byItem.get(r.ItemCode);
    if (!it) byItem.set(r.ItemCode, (it = { total: 0, centralStores: 0, stores: [] }));
    const qty = Number(r.Qty) || 0;
    const excluded = EXCLUDED_STORES.includes(r.StoreCode);
    if (!excluded) it.total += qty;
    if (String(r.Store).toUpperCase() === CENTRAL_STORES_NAME.toUpperCase()) it.centralStores += qty;
    it.stores.push({ storeCode: r.StoreCode, store: r.Store, qty: r3(qty), excluded });
  }
  for (const it of byItem.values()) {
    it.total = r3(it.total);
    it.centralStores = r3(it.centralStores);
    it.stores.sort((a, b) => b.qty - a.qty);
  }
  return byItem;
}

// ── Consumption ──────────────────────────────────────────────────────────────

// `db` is a bracketed database name for the prior year, or '' for the
// current-year database this pool is connected to.
const CONSUMPTION_SQL = (db, itemColumnSelect, itemWhere, excluded) => {
  const p = db ? `${db}.` : '';
  return `
  SELECT ${itemColumnSelect} AS ItemKey, DATEFROMPARTS(YEAR(t.[Date]), MONTH(t.[Date]), 1) AS Mth,
         SUM(CASE
               WHEN t.VchType = 6 AND t.Value1 < 0 THEN -t.Value1
               WHEN t.VchType = 11 AND t.Value1 < 0 AND pr.Code IS NULL THEN -t.Value1
               WHEN t.VchType = 5 THEN -t.Value1
               ELSE 0 END) AS Qty
  FROM ${p}dbo.Tran2 t
  LEFT JOIN (SELECT Code FROM ${p}dbo.Master1 WHERE MasterType = 21 AND LTRIM(RTRIM(Name)) = '11Pur-return') pr
    ON pr.Code = t.VchSeriesCode
  ${itemColumnSelect.startsWith('LTRIM') ? `JOIN ${p}dbo.Master1 i ON i.Code = t.MasterCode1` : ''}
  WHERE t.RecType = 2 AND t.MasterCode2 NOT IN (${excluded}) AND t.VchType IN (5, 6, 11)
    AND t.[Date] >= @from AND t.[Date] < @to ${itemWhere}
  GROUP BY ${itemColumnSelect}, DATEFROMPARTS(YEAR(t.[Date]), MONTH(t.[Date]), 1)`;
};

/**
 * Monthly consumption for the last `months` complete months + month to date.
 * Returns Map(itemCode -> { months: [{month, qty}], mtd, avg3, max6, min6 }).
 * `nameByCode` lets prior-year rows (different database) map back by name.
 */
async function getConsumption(erpPool, itemCodes, { months = 6, nameByCode } = {}) {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - months, 1);
  const monthList = [];
  for (let k = months; k >= 1; k--) monthList.push(monthKey(new Date(thisMonth.getFullYear(), thisMonth.getMonth() - k, 1)));

  const rows = [];
  const cur = erpPool.request().input('from', erpSql.DateTime, from).input('to', erpSql.DateTime, new Date(now.getTime() + 864e5));
  rows.push(...(await cur.query(CONSUMPTION_SQL('', 't.MasterCode1', itemFilter(cur, 't.MasterCode1', itemCodes), excludedList())))
    .recordset.map((r) => ({ code: r.ItemKey, mth: r.Mth, qty: Number(r.Qty) || 0 })));

  // Prior financial year (separate Busy database): item codes can differ
  // between years, so match by item name.
  try {
    const prev = erpPool.request().input('from', erpSql.DateTime, from).input('to', erpSql.DateTime, new Date(now.getTime() + 864e5));
    let nameWhere = '';
    let codeByName = null;
    if (itemCodes) {
      codeByName = new Map([...(nameByCode || new Map()).entries()].map(([c, n]) => [String(n).toUpperCase(), c]));
      const names = [...codeByName.keys()];
      if (names.length === 0) throw new Error('skip');
      // Small lists filter in SQL; big ones (the reorder sync) read every
      // item's prior-year totals and match by name here — SQL Server caps a
      // request at 2,100 parameters.
      if (names.length <= 500) {
        names.forEach((n, k) => prev.input(`pn${k}`, erpSql.NVarChar(60), n));
        nameWhere = ` AND UPPER(LTRIM(RTRIM(i.Name))) IN (${names.map((_, k) => `@pn${k}`).join(',')})`;
      }
    }
    const prevRows = (await prev.query(CONSUMPTION_SQL(`[${PREV_FY_DB}]`, 'LTRIM(RTRIM(i.Name))', nameWhere, excludedList()))).recordset;
    const allNames = codeByName || new Map([...(nameByCode || new Map()).entries()].map(([c, n]) => [String(n).toUpperCase(), c]));
    for (const r of prevRows) {
      const code = allNames.get(String(r.ItemKey).toUpperCase());
      if (code) rows.push({ code, mth: r.Mth, qty: Number(r.Qty) || 0 });
    }
  } catch (e) {
    if (e.message !== 'skip') throw e;
  }

  const byItem = new Map();
  for (const r of rows) {
    let it = byItem.get(r.code);
    if (!it) byItem.set(r.code, (it = { byMonth: {} }));
    const key = monthKey(new Date(r.mth));
    it.byMonth[key] = (it.byMonth[key] || 0) + r.qty;
  }
  const mtdKey = monthKey(thisMonth);
  const out = new Map();
  for (const [code, it] of byItem) {
    const series = monthList.map((m) => ({ month: m, qty: r3(Math.max(0, it.byMonth[m] || 0)) }));
    const last3 = series.slice(-3).map((s) => s.qty);
    const nonZero = series.map((s) => s.qty).filter((q) => q > 0);
    out.set(code, {
      months: series,
      mtd: r3(Math.max(0, it.byMonth[mtdKey] || 0)),
      avg3: r3(last3.reduce((a, b) => a + b, 0) / 3),
      max6: r3(Math.max(0, ...series.map((s) => s.qty))),
      min6: r3(nonZero.length ? Math.min(...nonZero) : 0),
    });
  }
  return out;
}

// ── Purchasing context ───────────────────────────────────────────────────────

/** EOQ = average PO line quantity this financial year. */
async function getEoq(erpPool, itemCodes) {
  const req = erpPool.request();
  const result = await req.query(`
    SELECT MasterCode1 AS ItemCode, AVG(ABS(Value1)) AS Eoq
    FROM dbo.Tran3 WHERE VchType = 13 AND Method = 1 AND RecType = 4 ${itemFilter(req, 'MasterCode1', itemCodes)}
    GROUP BY MasterCode1`);
  return new Map(result.recordset.map((r) => [r.ItemCode, r3(r.Eoq)]));
}

/** Latest receipt (GRN or purchase) per item: date, supplier, qty, price. */
async function getLastPurchase(erpPool, itemCodes) {
  const req = erpPool.request();
  const result = await req.query(`
    SELECT ItemCode, [Date], Party, Qty, Price, VchNo FROM (
      SELECT t2.MasterCode1 AS ItemCode, t2.[Date], LTRIM(RTRIM(p.Name)) AS Party, t2.D1 AS Qty,
             CASE WHEN t2.D1 <> 0 THEN t2.D5 / t2.D1 END AS Price, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
             ROW_NUMBER() OVER (PARTITION BY t2.MasterCode1 ORDER BY t2.[Date] DESC, t2.VchCode DESC) AS rn
      FROM dbo.Tran2 t2
      JOIN dbo.Tran1 t1 ON t1.VchCode = t2.VchCode
      LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
      WHERE t2.RecType = 2 AND t2.VchType IN (2, 4) AND t2.Value1 > 0
        AND NOT (t2.VchType = 4 AND t1.VchSeriesCode <> 12076) ${itemFilter(req, 't2.MasterCode1', itemCodes)}
    ) x WHERE rn = 1`);
  return new Map(result.recordset.map((r) => [r.ItemCode, {
    date: r.Date, supplier: r.Party, qty: r3(r.Qty), price: r2(r.Price), voucher: r.VchNo,
  }]));
}

/** Average inward price over the last 12 months, for stock value. */
async function getAvgInwardPrice(erpPool, itemCodes) {
  const req = erpPool.request().input('from', erpSql.DateTime, new Date(Date.now() - 365 * 864e5));
  const result = await req.query(`
    SELECT t2.MasterCode1 AS ItemCode, SUM(t2.D5) / NULLIF(SUM(t2.D1), 0) AS Price
    FROM dbo.Tran2 t2
    WHERE t2.RecType = 2 AND t2.VchType IN (2, 4) AND t2.Value1 > 0 AND t2.D1 > 0 AND t2.[Date] >= @from
      ${itemFilter(req, 't2.MasterCode1', itemCodes)}
    GROUP BY t2.MasterCode1`);
  return new Map(result.recordset.map((r) => [r.ItemCode, Number(r.Price) || null]));
}

// ── Batches ──────────────────────────────────────────────────────────────────

/**
 * True balance per batch per store (Tran3 stock rows, RecType 2, netted),
 * with the receipt price for valuation, plus a check that the batches add
 * up to the item's stock in that store (Busy's opening batches don't always).
 */
async function getBatchBalances(erpPool, { itemCode, storeName } = {}) {
  const req = erpPool.request().input('item', erpSql.Int, itemCode);
  let storeWhere = '';
  if (storeName) { storeWhere = ' AND UPPER(LTRIM(RTRIM(mc.Name))) = UPPER(LTRIM(RTRIM(@store)))'; req.input('store', erpSql.NVarChar(80), storeName); }
  const result = await req.query(`
    SELECT t3.MasterCode2 AS StoreCode, LTRIM(RTRIM(mc.Name)) AS Store, LTRIM(RTRIM(t3.No)) AS BatchNo,
           SUM(t3.Value1) AS Qty, MIN(t3.[Date]) AS FirstDate, MAX(t3.[Date]) AS LastMovement,
           SUM(CASE WHEN t3.Value1 > 0 THEN t3.Value1 * t3.Value3 END) / NULLIF(SUM(CASE WHEN t3.Value1 > 0 THEN t3.Value1 END), 0) AS InPrice,
           MAX(CASE WHEN t3.VchCode = 0 THEN 1 ELSE 0 END) AS FromOpening
    FROM dbo.Tran3 t3 JOIN dbo.Master1 mc ON mc.Code = t3.MasterCode2
    WHERE t3.RecType = 2 AND t3.MasterCode1 = @item ${storeWhere}
    GROUP BY t3.MasterCode2, mc.Name, LTRIM(RTRIM(t3.No))
    HAVING ABS(SUM(t3.Value1)) > 0.0001
    ORDER BY MIN(t3.[Date])`);
  const now = Date.now();
  const batches = result.recordset.map((b) => ({
    storeCode: b.StoreCode, store: b.Store, batchNo: b.BatchNo,
    qty: r3(b.Qty), unitPrice: r2(b.InPrice), amount: r2((Number(b.Qty) || 0) * (Number(b.InPrice) || 0)),
    batchDate: b.FirstDate, lastMovement: b.LastMovement, fromOpening: !!b.FromOpening,
    ageDays: b.FirstDate ? Math.floor((now - new Date(b.FirstDate).getTime()) / 864e5) : null,
  }));

  const stock = (await getStockByStore(erpPool, [itemCode])).get(itemCode) || { stores: [] };
  const checks = {};
  for (const b of batches) (checks[b.store] ||= { store: b.store, batchTotal: 0, stock: 0 }).batchTotal += b.qty;
  for (const s of stock.stores) {
    if (storeName && s.store.toUpperCase() !== storeName.toUpperCase()) continue;
    (checks[s.store] ||= { store: s.store, batchTotal: 0, stock: 0 }).stock = s.qty;
  }
  const reconciliation = Object.values(checks).map((c) => ({
    ...c, batchTotal: r3(c.batchTotal), difference: r3(c.batchTotal - c.stock),
  })).filter((c) => Math.abs(c.difference) > 0.0001);
  return { batches, reconciliation };
}

/**
 * Every batch with stock remaining, in every real store, company-wide —
 * for Aging Analysis. One row per item × store × batch (Tran3 stock rows,
 * RecType 2, netted); only positive balances; consumed store excluded.
 * Valued at the batch's own receipt price (weighted over its inward rows).
 */
// Stores left out of Aging Analysis on top of EXCLUDED_STORES — goods there
// are written off, not capital tied up ("Destruction", 2026-10-18).
const AGING_EXCLUDED_STORE_NAMES = String(process.env.AGING_EXCLUDED_STORES || 'Destruction')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

async function getAllBatchBalances(erpPool) {
  const req = erpPool.request();
  AGING_EXCLUDED_STORE_NAMES.forEach((n, k) => req.input(`ax${k}`, erpSql.NVarChar(80), n));
  const agingExcluded = AGING_EXCLUDED_STORE_NAMES.length
    ? ` AND UPPER(LTRIM(RTRIM(mc.Name))) NOT IN (${AGING_EXCLUDED_STORE_NAMES.map((_, k) => `@ax${k}`).join(',')})` : '';
  const result = await req.query(`
    SELECT t3.MasterCode1 AS ItemCode, LTRIM(RTRIM(i.Name)) AS ItemName, LTRIM(RTRIM(g.Name)) AS GroupName,
           t3.MasterCode2 AS StoreCode, LTRIM(RTRIM(mc.Name)) AS Store, LTRIM(RTRIM(t3.No)) AS BatchNo,
           SUM(t3.Value1) AS Qty,
           SUM(CASE WHEN t3.Value1 > 0 THEN t3.Value1 * t3.Value3 END) / NULLIF(SUM(CASE WHEN t3.Value1 > 0 THEN t3.Value1 END), 0) AS InPrice,
           MIN(CASE WHEN t3.[Date] > '1901-01-01' THEN t3.[Date] END) AS FirstDate,
           MAX(CASE WHEN t3.DueDate > '1901-01-01' THEN t3.DueDate END) AS DueDate
    FROM dbo.Tran3 t3
    JOIN dbo.Master1 i  ON i.Code = t3.MasterCode1 AND i.MasterType = 6
    JOIN dbo.Master1 mc ON mc.Code = t3.MasterCode2 AND mc.MasterType = 11
    LEFT JOIN dbo.Master1 g ON g.Code = i.ParentGrp
    WHERE t3.RecType = 2 AND t3.MasterCode2 NOT IN (${excludedList()})${agingExcluded}
    GROUP BY t3.MasterCode1, i.Name, g.Name, t3.MasterCode2, mc.Name, LTRIM(RTRIM(t3.No))
    HAVING SUM(t3.Value1) > 0.0001`);
  return result.recordset.map((b) => ({
    itemCode: b.ItemCode, itemName: b.ItemName, group: b.GroupName, storeCode: b.StoreCode, store: b.Store,
    batchNo: b.BatchNo || '(no batch)', qty: r3(b.Qty), unitPrice: r2(b.InPrice),
    amount: r2((Number(b.Qty) || 0) * (Number(b.InPrice) || 0)), batchDate: b.FirstDate, dueDate: b.DueDate,
  }));
}

// ── The whole picture ────────────────────────────────────────────────────────

function computeLevels({ live, cons, leadWeeks, eoq }) {
  const lead = leadWeeks / 4;
  if (!cons || (cons.max6 || 0) === 0) {
    return { reorderLevel: 0, minLevel: 0, maxLevel: null, status: live <= 0 ? 'Out of stock' : 'No consumption', monthsOfCover: null };
  }
  const reorderLevel = r2(cons.max6 * lead);
  const minLevel = r2(Math.max(0, (cons.max6 - cons.avg3) * lead));
  const maxLevel = r2(Math.max(reorderLevel, cons.max6 * lead + (eoq || 0) - cons.min6 * lead));
  let status = 'OK';
  if (live <= 0) status = 'Out of stock';
  else if (live <= minLevel) status = 'Critical';
  else if (live <= reorderLevel) status = 'Reorder';
  return { reorderLevel, minLevel, maxLevel, status, monthsOfCover: cons.avg3 > 0 ? r2(live / cons.avg3) : null };
}

/**
 * Everything needed to decide on an item: live stock (company + Central
 * Stores + per store), monthly consumption, lead time, reorder/min/max
 * levels, status, open PO quantity, last purchase. `getOpenPoLines` is
 * injected to avoid a require cycle with busy-receiving.service.js.
 */
async function getStockPicture(erpPool, { itemCodes = [], itemNames = [] }, { getOpenPoLines }) {
  const items = await resolveItems(erpPool, { itemCodes, itemNames });
  if (items.length === 0) return [];
  const codes = items.map((i) => i.itemCode);
  const nameByCode = new Map(items.map((i) => [i.itemCode, i.itemName]));
  const [stock, cons, eoq, last, poLines] = await Promise.all([
    getStockByStore(erpPool, codes),
    getConsumption(erpPool, codes, { nameByCode }),
    getEoq(erpPool, codes),
    getLastPurchase(erpPool, codes),
    getOpenPoLines(erpPool, { itemCodes: codes }),
  ]);
  const poByItem = {};
  for (const l of poLines) (poByItem[l.itemCode] ||= []).push(l);

  return items.map((it) => {
    const st = stock.get(it.itemCode) || { total: 0, centralStores: 0, stores: [] };
    const c = cons.get(it.itemCode) || null;
    const nonStock = isNonStock(it.group);
    const levels = nonStock
      ? { reorderLevel: null, minLevel: null, maxLevel: null, status: 'Service (no stock)', monthsOfCover: null }
      : computeLevels({ live: st.total, cons: c, leadWeeks: it.leadWeeks, eoq: eoq.get(it.itemCode) });
    const pos = poByItem[it.itemCode] || [];
    const onOrder = r3(pos.filter((p) => p.approved).reduce((s, p) => s + p.pending, 0));
    return {
      ...it,
      nonStock,
      liveStock: st.total,
      centralStores: st.centralStores,
      stores: st.stores,
      consumption: c ? { avgMonthly: c.avg3, maxMonthly: c.max6, minMonthly: c.min6, monthToDate: c.mtd, months: c.months } : null,
      eoq: eoq.get(it.itemCode) ?? null,
      ...levels,
      onOrder,
      openPos: pos.map((p) => ({ poNo: p.poNo, poDate: p.poDate, party: p.party, pending: p.pending, approved: p.approved })),
      // What to order now so stock + open POs reach the maximum level.
      suggestedOrderQty: levels.maxLevel == null ? null : r2(Math.max(0, levels.maxLevel - st.total - onOrder)),
      lastPurchase: last.get(it.itemCode) || null,
    };
  });
}

module.exports = {
  DEFAULT_LEAD_WEEKS,
  EXCLUDED_STORES,
  FG_GROUPS,
  isNonStock,
  resolveItems,
  getStockByStore,
  getConsumption,
  getEoq,
  getAvgInwardPrice,
  getLastPurchase,
  getBatchBalances,
  getAllBatchBalances,
  computeLevels,
  getStockPicture,
};
