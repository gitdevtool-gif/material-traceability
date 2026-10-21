/**
 * Requisition Item Catalog Service
 *
 * Two things shared between the in-system requisition-creation flow
 * (requisition-create.routes.js) and the existing "Refresh Categories"
 * endpoint (requisitions.routes.js POST /:id/recategorize):
 *
 *  - getItemOptions(): the live item + current-stock + category list any
 *    clerk picks from. The catalog itself (names/categories) is sourced
 *    entirely from Busy's [All stocks] batch ledger, not Itemwise_Stock
 *    (2026-09-16). Deliberately NOT filtered to the requesting clerk's
 *    own AssignedMatCenter either: a clerk at F1 must still be able to
 *    request, say, an engineering item that's only ever stocked at
 *    Workshop — the item catalog is company-wide; only the requisition's
 *    own MatCenter/routing stays locked to the clerk. The current-stock
 *    NUMBER shown still comes from Itemwise_Stock (summed across every
 *    factory) since [All stocks] can't produce a sane balance by
 *    summation — see the long comment in getItemOptions for what was
 *    tried and why.
 *
 *  - resolveCategoryForItemNames(itemNames): derives a Category per item
 *    name, preferring dbo.Itemwise_Stock's own category column (deduped
 *    across factories, since that table has one row per item×factory —
 *    a handful of admin/non-stock items, e.g. "Kebs Levy", carry a
 *    different category per factory and are treated as ambiguous same as
 *    below) and falling back to Busy's historical dbo.PurIndents.category
 *    data for anything Itemwise_Stock doesn't resolve. Not the separate,
 *    unused dbo.ItemCategoryMap table. Extracted here so every caller
 *    shares one implementation instead of copies drifting apart.
 *
 *  - resolveItemCodeLookup(codes): some items only exist in Busy's stock
 *    view under a bare product code (e.g. "ING-0141") rather than a
 *    readable name. The item picker still shows/selects that code
 *    unchanged, but dbo.ItemCodeLookup (own DB, Admin-managed — Busy has
 *    no such mapping) supplies the real name so everything raised
 *    against a coded item shows the real name to Central Stores,
 *    Procurement, and the supplier from that point on.
 */
const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');

async function getItemOptions() {
  const erpPool = await getErpPool();
  // Item NAME/CATALOG list is sourced entirely from [All stocks]
  // (2026-09-16, per explicit instruction to drop Itemwise_Stock as the
  // catalog source) — the batch-wise stock ledger (= BatchwiseStock
  // UNION ALL BatchwiseStockExcluded, verified identical row-for-row).
  // It covers 6,799 distinct item names vs Itemwise_Stock's 5,530, so
  // items with batch movement but no current-stock snapshot yet still
  // show up to pick from. Trade-off accepted knowingly: 84 item names
  // that exist ONLY in Itemwise_Stock (verified live, e.g. some finished
  // goods/labels with no batch-ledger rows at all) are no longer
  // selectable from Itemwise_Stock (but see the MasterCode fallback
  // below, which now covers item masters with no batch rows). No
  // Factory filter: the catalog is company-wide (see header note) —
  // GROUP BY Item_Name alone collapses every factory's rows for that item
  // into one entry.
  //
  // The current-stock QUANTITY shown is still read from Itemwise_Stock
  // (company-wide total, summed across every factory) rather than from
  // this ledger: verified live, three different ways, that [All stocks]
  // cannot produce a sane balance by summation — grouped by item+factory,
  // grouped by item company-wide, doesn't matter — every variant came out
  // negative for the majority of items, down to -319 million on outliers
  // like "Adj-opening". It's a historical transaction log, not a balance
  // snapshot. An item present in [All stocks] but absent from
  // Itemwise_Stock simply shows no stock figure (frontend already renders
  // "current stock: unknown" for that case).
  //
  // Itemwise_Stock has real duplicate (Name, factory) rows for ~6.6% of
  // items (393 pairs, verified 2026-09-15) — a SUM over those raw rows
  // would double-count a duplicated factory's stock, so the same
  // ROW_NUMBER dedup (one row per Name+factory, preferring a non-blank
  // category/non-null stock) runs first and the SUM is taken over that
  // deduped set before totalling across factories.
  //
  // Fallback (2026-09-25): item masters with no batch transaction at all
  // (~1,074 verified live — never purchased/received, so absent from
  // [All stocks]) are unioned in from Busy's dbo.MasterCode view (every
  // Master1 row, with its parent group's name as category). MasterCode
  // doesn't expose MasterType and also holds accounts/groups/units etc.,
  // so it's restricted to MasterType = 6 (Busy's item master) via Master1.
  const result = await erpPool.request().query(`
    WITH batchItems AS (
      SELECT [Item_Name], MAX([category]) AS [category]
      FROM [All stocks]
      GROUP BY [Item_Name]
    ),
    masterOnlyItems AS (
      SELECT mc.[Name] AS [Item_Name], MAX(mc.[category]) AS [category]
      FROM dbo.MasterCode mc
      WHERE mc.[Code] IN (SELECT [Code] FROM dbo.Master1 WHERE [MasterType] = 6)
        AND mc.[Name] IS NOT NULL AND LTRIM(RTRIM(mc.[Name])) <> ''
        AND NOT EXISTS (SELECT 1 FROM batchItems b WHERE b.[Item_Name] = mc.[Name])
      GROUP BY mc.[Name]
    ),
    allItems AS (
      SELECT [Item_Name], [category] FROM batchItems
      UNION ALL
      SELECT [Item_Name], [category] FROM masterOnlyItems
    ),
    ranked AS (
      SELECT [Name], [factory], [currentstock], [category],
        ROW_NUMBER() OVER (
          PARTITION BY [Name], [factory]
          ORDER BY
            CASE WHEN [category] IS NOT NULL AND LTRIM(RTRIM([category])) <> '' THEN 0 ELSE 1 END,
            CASE WHEN [currentstock] IS NOT NULL THEN 0 ELSE 1 END
        ) AS rn
      FROM dbo.Itemwise_Stock
    ),
    totals AS (
      SELECT [Name], SUM([currentstock]) AS [currentstock], MAX([category]) AS [category]
      FROM ranked
      WHERE rn = 1
      GROUP BY [Name]
    )
    SELECT
      a.[Item_Name] AS [Name],
      t.[currentstock],
      COALESCE(t.[category], a.[category]) AS [category]
    FROM allItems a
    LEFT JOIN totals t ON t.[Name] = a.[Item_Name]
    ORDER BY a.[Item_Name]
  `);
  return result.recordset;
}

// Every Material Centre defined in Busy (Master1 MasterType 11) — the exact
// names the PO push resolves the requisition's store against (2026-10-18).
// The old Itemwise_Stock "factory" list missed stores with no stock rows and
// let users be assigned names Busy doesn't have (e.g. "ENGINEERING", "F2"),
// which then failed when the LPO was raised in Busy.
async function getMatCenterOptions() {
  const erpPool = await getErpPool();
  const result = await erpPool.request().query(`
    SELECT LTRIM(RTRIM(Name)) AS Name FROM dbo.Master1
    WHERE MasterType = 11 AND LTRIM(RTRIM(Name)) <> ''
    ORDER BY Name
  `);
  return result.recordset.map((r) => r.Name);
}

// Maps a store name to Busy's exact spelling (case-insensitive), or null if
// Busy has no such Material Centre.
async function normalizeBusyMatCenter(name) {
  const wanted = String(name || '').trim().toUpperCase();
  if (!wanted) return null;
  const options = await getMatCenterOptions();
  return options.find((o) => o.toUpperCase() === wanted) || null;
}

// Runs the same "one category per item name, drop it if it's ever
// recorded inconsistently" reduction against any {ItemName, Category} row
// set — shared by both sources resolveCategoryForItemNames tries below.
function reduceToUnambiguousCategories(rows, wanted) {
  const categoryByItemName = new Map();
  const ambiguousItemNames = new Set();

  for (const row of rows) {
    const itemName = String(row.ItemName || '').trim();
    const category = String(row.Category || '').trim();
    if (!itemName || !category || !wanted.has(itemName)) continue;

    if (!categoryByItemName.has(itemName)) {
      categoryByItemName.set(itemName, category);
    } else if (categoryByItemName.get(itemName) !== category) {
      ambiguousItemNames.add(itemName);
    }
  }

  const resolved = new Map();
  for (const itemName of categoryByItemName.keys()) {
    if (!ambiguousItemNames.has(itemName)) {
      resolved.set(itemName, categoryByItemName.get(itemName));
    }
  }
  return resolved;
}

// Builds itemName -> category, preferring dbo.Itemwise_Stock's own
// category column (comprehensive — covers ~93% of all items regardless
// of order history) and falling back to Busy's historical
// dbo.PurIndents.category data for anything left unresolved (older/rarer
// items Itemwise_Stock doesn't cover yet). Ambiguous either way (the same
// item name recorded under more than one category) is left unresolved
// rather than guessed at.
async function resolveCategoryForItemNames(itemNames) {
  const wanted = new Set(itemNames.map((n) => String(n).trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();

  const erpPool = await getErpPool();

  const stockResult = await erpPool.request().query(`
    SELECT DISTINCT
      LTRIM(RTRIM([Name])) AS ItemName,
      LTRIM(RTRIM([category])) AS Category
    FROM dbo.Itemwise_Stock
    WHERE [category] IS NOT NULL
      AND LTRIM(RTRIM([category])) <> ''
  `);
  const resolved = reduceToUnambiguousCategories(stockResult.recordset, wanted);

  const stillWanted = new Set([...wanted].filter((n) => !resolved.has(n)));
  if (stillWanted.size > 0) {
    const purIndentsResult = await erpPool.request().query(`
      SELECT DISTINCT
        LTRIM(RTRIM([itemName])) AS ItemName,
        LTRIM(RTRIM([category])) AS Category
      FROM dbo.PurIndents
      WHERE [category] IS NOT NULL
        AND LTRIM(RTRIM([category])) <> ''
    `);
    const fallback = reduceToUnambiguousCategories(purIndentsResult.recordset, stillWanted);
    for (const [itemName, category] of fallback) resolved.set(itemName, category);
  }

  return resolved;
}

// Looks up each of the given codes (as chosen from the item-picker
// dropdown, e.g. "ING-0141") against dbo.ItemCodeLookup and returns a
// Map keyed by the trimmed, lowercased code -> { itemName, category }.
// Codes with no entry simply aren't in the returned Map (caller falls
// back to using the raw code as the item name, unchanged from today).
async function resolveItemCodeLookup(codes) {
  const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const pool = await getPool();
  const request = pool.request();
  const placeholders = wanted.map((code, i) => {
    request.input(`code${i}`, sql.NVarChar(50), code);
    return `@code${i}`;
  });
  const result = await request.query(`
    SELECT ItemCode, ItemName, Category
    FROM dbo.ItemCodeLookup
    WHERE ItemCode IN (${placeholders.join(',')})
  `);

  const resolved = new Map();
  for (const row of result.recordset) {
    resolved.set(String(row.ItemCode).trim().toLowerCase(), {
      itemName: row.ItemName,
      category: row.Category,
    });
  }
  return resolved;
}

// resolveItemCodeLookup() above only runs for manually-raised requisitions
// at creation time, so codes still leaked through to Procurement on
// (a) Busy-synced requisitions (procurement-sync.service.js never looked
// them up), and (b) any requisition raised before its code was added to
// dbo.ItemCodeLookup. This set-based pass fixes stored rows in place:
// ItemName gets the real name, the raw code moves to ItemCode for
// traceability (same shape requisition-create.routes.js writes), and a
// missing Category is filled from the lookup. Rows already resolved
// (ItemCode IS NOT NULL) are left alone, so this is safe to call as often
// as needed. Pass a requisitionId to scope it, or omit it for all rows.
// Returns the number of items updated.
async function applyItemCodeLookupToRequisitionItems(requisitionId = null, executor = null) {
  const request = executor ? new sql.Request(executor) : (await getPool()).request();
  let scope = '';
  if (requisitionId) {
    request.input('requisitionId', sql.Int, requisitionId);
    scope = 'AND ri.RequisitionId = @requisitionId';
  }
  const result = await request.query(`
    UPDATE ri
    SET ri.ItemCode = LTRIM(RTRIM(ri.ItemName)),
        ri.ItemName = l.ItemName,
        ri.Category = COALESCE(ri.Category, l.Category)
    FROM dbo.RequisitionItems ri
    JOIN dbo.ItemCodeLookup l ON l.ItemCode = LTRIM(RTRIM(ri.ItemName))
    WHERE ri.ItemCode IS NULL ${scope}
  `);
  return result.rowsAffected[0] || 0;
}

module.exports = {
  getItemOptions,
  getMatCenterOptions,
  normalizeBusyMatCenter,
  resolveCategoryForItemNames,
  resolveItemCodeLookup,
  applyItemCodeLookupToRequisitionItems,
};
