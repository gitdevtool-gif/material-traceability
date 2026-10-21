/**
 * Production planning engine (2026-10-18) — replaces dbo.fn_ProductionBOM /
 * fn_ItemPendingOrders. Read-only against Busy.
 *
 * How Busy stores a BOM (verified on BusyComp0006_db12026):
 *   Master1 MasterType 15 = one BOM ("recipe"):
 *     CM1  item it PRODUCES        D1  quantity one batch produces
 *   MasterSupport (MasterCode = BOM code), I1 = 2 = an item CONSUMED:
 *     CM1  component item          D1  qty per batch     CM2  unit
 *   A component that has its own BOM (a BOM whose CM1 is that item) is
 *   semi-finished — e.g. American Gourmet Ketchup 5Kg → Tomato Ketchup
 *   J/Can 5KG → Tomato Ketchups Bulk → raw materials.
 * The old fn_ProductionBOM looked for a sub-recipe under the component's
 * ITEM code instead of the BOM that produces it, so nothing below level 1
 * ever exploded, and it ignored the batch quantity.
 *
 * Planning (MRP, level by level):
 *   1. each planned product's quantity is turned into its components'
 *      gross requirement:  component qty × planned qty / BOM batch qty
 *   2. requirements for the same item are added up across all products
 *   3. a semi-finished item is netted against its own stock (optional) and
 *      only the shortfall is exploded into ITS components, and so on down
 *   4. bought items: shortage = required − stock − pending POs
 * Stock = live company stock (services/stock.service.js — the same figure
 * Busy shows). Pending PO / pending sales order are exact, from Busy's own
 * pending-order references (Tran3 RecType 4): ordered minus everything
 * received / delivered against each line.
 */
const stock = require('./stock.service');
const { getOpenPoLines } = require('./busy-receiving.service');

const r3 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
const MAX_LEVELS = 10;
// Recipes also carry cost lines that aren't stock: labour ("monthly
// contract", "perm-f2" — MANPOWER), "power cost" (ELECTRICITY), "firewood &
// fuel costs", "Water". They're consumed but never received, so their
// "stock" runs hugely negative. Treated as overheads, never as a shortage:
// group in this list, or never received on a GRN/purchase with stock <= 0.
const OVERHEAD_GROUPS = new Set(String(process.env.BOM_OVERHEAD_GROUPS || 'MANPOWER,ELECTRICITY')
  .split(',').map((g) => g.trim().toUpperCase()).filter(Boolean));

async function getEverReceived(erpPool, itemCodes) {
  const ids = [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))];
  if (!ids.length) return new Set();
  const r = await erpPool.request().query(`
    SELECT DISTINCT MasterCode1 AS ItemCode FROM dbo.Tran2
    WHERE RecType = 2 AND VchType IN (2, 4) AND Value1 > 0 AND MasterCode1 IN (${ids.join(',')})`);
  return new Set(r.recordset.map((x) => x.ItemCode));
}

// ── BOM masters (cached — 1,500 recipes change rarely) ───────────────────────
let bomCache = { at: 0, data: null };
const BOM_CACHE_MS = 5 * 60 * 1000;

async function loadBoms(erpPool) {
  if (bomCache.data && Date.now() - bomCache.at < BOM_CACHE_MS) return bomCache.data;
  const [heads, comps] = await Promise.all([
    erpPool.request().query(`
      SELECT b.Code, LTRIM(RTRIM(b.Name)) AS Name, b.CM1 AS ItemCode, b.D1 AS BatchQty,
             LTRIM(RTRIM(i.Name)) AS ItemName, LTRIM(RTRIM(i.Alias)) AS Alias
      FROM dbo.Master1 b LEFT JOIN dbo.Master1 i ON i.Code = b.CM1
      WHERE b.MasterType = 15`),
    erpPool.request().query(`
      SELECT ms.MasterCode AS BomCode, ms.CM1 AS ItemCode, ms.D1 AS Qty
      FROM dbo.MasterSupport ms JOIN dbo.Master1 b ON b.Code = ms.MasterCode AND b.MasterType = 15
      WHERE ms.I1 = 2 AND ms.D1 > 0`),
  ]);
  const byCode = new Map();
  for (const h of heads.recordset) {
    byCode.set(h.Code, {
      bomCode: h.Code, bomName: h.Name, itemCode: h.ItemCode, itemName: h.ItemName, alias: h.Alias || null,
      batchQty: Number(h.BatchQty) > 0 ? Number(h.BatchQty) : 1, components: [],
    });
  }
  for (const c of comps.recordset) byCode.get(c.BomCode)?.components.push({ itemCode: c.ItemCode, qty: Number(c.Qty) });
  // Item → its BOMs (30 items have more than one; the one with most components first, then lowest code).
  const byItem = new Map();
  for (const b of byCode.values()) {
    if (!b.components.length) continue;
    (byItem.get(b.itemCode) || byItem.set(b.itemCode, []).get(b.itemCode)).push(b);
  }
  for (const list of byItem.values()) list.sort((a, b) => b.components.length - a.components.length || a.bomCode - b.bomCode);
  bomCache = { at: Date.now(), data: { byCode, byItem } };
  return bomCache.data;
}

/** Products that have a usable recipe, matched on BOM name, item name or alias. */
async function searchProducts(erpPool, search, limit = 30) {
  const q = String(search || '').trim().toUpperCase();
  if (q.length < 2) return [];
  const { byCode, byItem } = await loadBoms(erpPool);
  return [...byCode.values()]
    .filter((b) => b.components.length && [b.bomName, b.itemName, b.alias].some((s) => String(s || '').toUpperCase().includes(q)))
    .slice(0, limit)
    .map((b) => ({
      bomCode: b.bomCode, bomName: b.bomName, itemCode: b.itemCode, itemName: b.itemName, alias: b.alias,
      batchQty: b.batchQty, components: b.components.length, otherBoms: (byItem.get(b.itemCode) || []).length - 1,
    }));
}

/** Pending sales-order quantity per item (approved SOs, ordered − delivered). */
async function getPendingSalesOrders(erpPool, itemCodes) {
  const ids = itemCodes ? [...new Set(itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite))] : null;
  if (ids && ids.length === 0) return new Map();
  const result = await erpPool.request().query(`
    WITH so AS (
      SELECT t3.RefCode, t3.MasterCode1 AS ItemCode, ABS(t3.Value1) AS Ordered, t3.VchCode
      FROM dbo.Tran3 t3 JOIN dbo.Tran1 t1 ON t1.VchCode = t3.VchCode
      WHERE t3.VchType = 12 AND t3.Method = 1 AND t3.RecType = 4 AND t1.ApprovalStatus <> 2
        ${ids ? `AND t3.MasterCode1 IN (${ids.join(',')})` : ''}
    ), dl AS (
      SELECT x.RefCode, SUM(ABS(x.Value1)) AS Delivered FROM dbo.Tran3 x
      WHERE x.RecType = 4 AND x.Method = 2 AND x.RefCode IN (SELECT RefCode FROM so) GROUP BY x.RefCode
    )
    SELECT so.ItemCode, SUM(so.Ordered - ISNULL(dl.Delivered, 0)) AS Pending, COUNT(DISTINCT so.VchCode) AS Orders
    FROM so LEFT JOIN dl ON dl.RefCode = so.RefCode
    WHERE so.Ordered - ISNULL(dl.Delivered, 0) > 0.0001
    GROUP BY so.ItemCode`);
  return new Map(result.recordset.map((r) => [r.ItemCode, { pending: r3(r.Pending), orders: r.Orders }]));
}

/**
 * Finished goods customers are waiting for: pending sales orders vs stock,
 * for items that have a recipe — the natural starting point for a plan.
 */
async function getDemand(erpPool) {
  const { byItem } = await loadBoms(erpPool);
  const so = await getPendingSalesOrders(erpPool, null);
  const codes = [...so.keys()].filter((c) => byItem.has(c));
  if (!codes.length) return [];
  const [st, items] = await Promise.all([stock.getStockByStore(erpPool, codes), stock.resolveItems(erpPool, { itemCodes: codes })]);
  const meta = new Map(items.map((i) => [i.itemCode, i]));
  return codes.map((c) => {
    const bom = byItem.get(c)[0];
    const live = st.get(c)?.total ?? 0;
    const pending = so.get(c).pending;
    return {
      itemCode: c, itemName: meta.get(c)?.itemName || bom.itemName, unitName: meta.get(c)?.unitName || null,
      group: meta.get(c)?.group || null, bomCode: bom.bomCode, bomName: bom.bomName,
      pendingSalesOrders: pending, salesOrders: so.get(c).orders, stock: r3(live),
      toProduce: r3(Math.max(0, pending - Math.max(0, live))),
    };
  }).sort((a, b) => b.toProduce - a.toProduce);
}

/**
 * Build a production plan.
 * lines: [{ bomCode, qty }]   options: { netSemiFinishedStock = true }
 */
async function buildPlan(erpPool, lines, { netSemiFinishedStock = true } = {}) {
  const { byCode, byItem } = await loadBoms(erpPool);
  const warnings = [];
  const products = [];
  const gross = new Map();       // itemCode → gross requirement (all levels)
  const levelOf = new Map();     // itemCode → deepest level it appears at
  const usedIn = new Map();      // itemCode → Set(parent item names)
  const toProduce = new Map();   // semi-finished itemCode → qty to make after netting
  const bomUsed = new Map();     // semi-finished itemCode → BOM used

  let frontier = new Map();      // itemCode → qty to explode at this level
  for (const l of lines) {
    const bom = byCode.get(parseInt(l.bomCode, 10));
    const qty = Number(l.qty);
    if (!bom || !bom.components.length) { warnings.push(`Recipe ${l.bomCode} not found or has no components.`); continue; }
    if (!(qty > 0)) continue;
    products.push({ bom, qty });
    frontier.set(`bom:${bom.bomCode}`, { bom, qty, parent: bom.itemName, ancestors: new Set([bom.itemCode]) });
  }
  if (!products.length) return { products: [], semiFinished: [], materials: [], warnings };

  // Stock is needed while exploding (semi-finished netting) — load lazily per level.
  const stockCache = new Map();
  const getStock = async (codes) => {
    const missing = codes.filter((c) => !stockCache.has(c));
    if (missing.length) {
      const s = await stock.getStockByStore(erpPool, missing);
      for (const c of missing) stockCache.set(c, s.get(c) || { total: 0, centralStores: 0, stores: [] });
    }
  };

  const remainingSemiStock = new Map();
  for (let level = 1; level <= MAX_LEVELS && frontier.size; level++) {
    const next = new Map();
    for (const { bom, qty, parent, ancestors } of frontier.values()) {
      for (const comp of bom.components) {
        const req = (comp.qty * qty) / bom.batchQty;
        gross.set(comp.itemCode, (gross.get(comp.itemCode) || 0) + req);
        levelOf.set(comp.itemCode, Math.max(levelOf.get(comp.itemCode) || 0, level));
        (usedIn.get(comp.itemCode) || usedIn.set(comp.itemCode, new Set()).get(comp.itemCode)).add(parent);
        const sub = byItem.get(comp.itemCode)?.[0];
        // Busy has recipe loops (e.g. TOMATO PASTE BULK → KOL-TOMATO PASTE
        // 2.2KG → … → TOMATO PASTE BULK, a rework recipe): never expand an
        // item inside its own chain — it's taken from stock / bought there.
        if (sub && ancestors.has(comp.itemCode)) {
          warnings.push(`Recipe loop in Busy: "${sub.itemName}" is used inside its own recipe chain — not expanded again there.`);
        } else if (sub && sub.bomCode !== bom.bomCode) {
          const key = comp.itemCode;
          const prev = next.get(key);
          next.set(key, {
            bom: sub, qty: (prev?.qty || 0) + req, parent: sub.itemName || bom.itemName,
            ancestors: new Set([...(prev?.ancestors || []), ...ancestors, comp.itemCode]),
          });
          bomUsed.set(comp.itemCode, sub);
          if ((byItem.get(comp.itemCode) || []).length > 1) {
            warnings.push(`${sub.itemName} has ${(byItem.get(comp.itemCode) || []).length} recipes in Busy — using "${sub.bomName}".`);
          }
        }
      }
    }
    // Net semi-finished requirements against their own stock before going a level down.
    if (netSemiFinishedStock && next.size) {
      await getStock([...next.keys()]);
      for (const [code, entry] of next) {
        if (!remainingSemiStock.has(code)) remainingSemiStock.set(code, Math.max(0, stockCache.get(code).total));
        const avail = remainingSemiStock.get(code);
        const use = Math.min(avail, entry.qty);
        remainingSemiStock.set(code, avail - use);
        entry.qty -= use;
        toProduce.set(code, (toProduce.get(code) || 0) + entry.qty);
        if (entry.qty <= 0.0000001) next.delete(code);
      }
    } else {
      for (const [code, entry] of next) toProduce.set(code, (toProduce.get(code) || 0) + entry.qty);
    }
    frontier = next;
    if (level === MAX_LEVELS && frontier.size) warnings.push('Recipes nest more than 10 levels deep — stopped expanding (possible loop in Busy BOMs).');
  }

  const codes = [...new Set([...gross.keys(), ...products.map((p) => p.bom.itemCode)])];
  await getStock(codes);
  const [items, poLines, so, everReceived] = await Promise.all([
    stock.resolveItems(erpPool, { itemCodes: codes }),
    getOpenPoLines(erpPool, { itemCodes: codes }),
    getPendingSalesOrders(erpPool, codes),
    getEverReceived(erpPool, codes),
  ]);
  const meta = new Map(items.map((i) => [i.itemCode, i]));
  const po = new Map();
  for (const l of poLines) {
    if (!l.approved) continue;
    const p = po.get(l.itemCode) || { qty: 0, orders: [] };
    p.qty += l.pending;
    p.orders.push(l.poNo);
    po.set(l.itemCode, p);
  }

  const row = (code) => {
    const m = meta.get(code) || {};
    const st = stockCache.get(code) || { total: 0, centralStores: 0 };
    return {
      itemCode: code, itemName: m.itemName || byItem.get(code)?.[0]?.itemName || `#${code}`, unitName: m.unitName || null,
      group: m.group || null, nonStock: stock.isNonStock(m.group),
      stock: r3(st.total), centralStores: r3(st.centralStores),
      pendingPO: r3(po.get(code)?.qty || 0), poNos: [...new Set(po.get(code)?.orders || [])],
      pendingSalesOrders: r3(so.get(code)?.pending || 0),
    };
  };

  const productRows = products.map(({ bom, qty }) => {
    const r = row(bom.itemCode);
    return { ...r, bomCode: bom.bomCode, bomName: bom.bomName, batchQty: bom.batchQty, planQty: r3(qty),
      // what customers are still waiting for vs what's in stock
      salesOrderGap: r3(Math.max(0, r.pendingSalesOrders - Math.max(0, r.stock))) };
  });

  const semiFinished = [...bomUsed.keys()].map((code) => {
    const r = row(code);
    return { ...r, level: levelOf.get(code), bomName: bomUsed.get(code).bomName, required: r3(gross.get(code)),
      toProduce: r3(toProduce.get(code) || 0), usedIn: [...(usedIn.get(code) || [])] };
  }).sort((a, b) => a.level - b.level || a.itemName.localeCompare(b.itemName));

  const materials = [...gross.keys()].filter((code) => !bomUsed.has(code)).map((code) => {
    const r = row(code);
    const required = r3(gross.get(code));
    const overhead = r.nonStock || OVERHEAD_GROUPS.has(String(r.group || '').toUpperCase())
      || (!everReceived.has(code) && r.stock <= 0 && r.pendingPO === 0);
    const shortage = overhead ? null : r3(Math.max(0, required - Math.max(0, r.stock) - r.pendingPO));
    const shortWithoutPo = overhead ? null : r3(Math.max(0, required - Math.max(0, r.stock)));
    return { ...r, level: levelOf.get(code), required, shortage, overhead,
      status: overhead ? 'Overhead (not stocked)' : shortWithoutPo === 0 ? 'In stock' : shortage === 0 ? 'Covered by open PO' : 'Short — buy',
      usedIn: [...(usedIn.get(code) || [])] };
  }).sort((a, b) => (a.overhead - b.overhead) || (b.shortage || 0) - (a.shortage || 0) || a.itemName.localeCompare(b.itemName));

  return { products: productRows, semiFinished, materials, warnings: [...new Set(warnings)] };
}

module.exports = { loadBoms, searchProducts, getPendingSalesOrders, getDemand, buildPlan };
