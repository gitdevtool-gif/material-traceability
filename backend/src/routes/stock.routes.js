/**
 * Stock picture routes (2026-10-17) — the "whole picture" for any item at
 * every decision point (Central Stores review, Ops approval, Procurement
 * before dispatching an RFQ, the Director choosing a winner, raising the PO
 * in Busy). Read-only against Busy; see services/stock.service.js.
 *
 *   POST /api/stock/picture   { itemNames?: string[], itemCodes?: number[] }
 *   GET  /api/stock/batches?itemCode=&store=
 */
const express = require('express');
const { getErpPool } = require('../erpDb');
const { authenticate } = require('../middleware/auth');
const stock = require('../services/stock.service');
const { getOpenPoLines } = require('../services/busy-receiving.service');

const router = express.Router();

// Pages poll / re-open the same requisition — keep Busy load low.
const cache = new Map();
const CACHE_MS = 60_000;

router.post('/picture', authenticate, async (req, res, next) => {
  try {
    const itemNames = Array.isArray(req.body.itemNames) ? req.body.itemNames.map(String).slice(0, 200) : [];
    const itemCodes = Array.isArray(req.body.itemCodes) ? req.body.itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite).slice(0, 200) : [];
    if (!itemNames.length && !itemCodes.length) return res.json({ items: [], notFound: [] });

    const key = JSON.stringify([itemNames.map((n) => n.trim().toUpperCase()).sort(), [...itemCodes].sort()]);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return res.json(hit.value);

    const items = await stock.getStockPicture(await getErpPool(), { itemNames, itemCodes }, { getOpenPoLines });
    const found = new Set(items.map((i) => i.itemName.toUpperCase()));
    const value = {
      items,
      // Names that aren't a Busy item (e.g. typed on a manual requisition) — no stock data exists for them.
      notFound: itemNames.filter((n) => !found.has(String(n).trim().toUpperCase())),
      defaultLeadWeeks: stock.DEFAULT_LEAD_WEEKS,
      asOf: new Date().toISOString(),
    };
    cache.set(key, { value, expires: Date.now() + CACHE_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    res.json(value);
  } catch (err) { next(err); }
});

router.get('/batches', authenticate, async (req, res, next) => {
  try {
    const itemCode = parseInt(req.query.itemCode, 10);
    if (!itemCode) return res.status(400).json({ error: 'itemCode is required' });
    res.json(await stock.getBatchBalances(await getErpPool(), { itemCode, storeName: req.query.store || null }));
  } catch (err) { next(err); }
});

module.exports = router;
