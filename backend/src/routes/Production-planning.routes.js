/**
 * Production Planning Routes
 *
 * Rebuilt 2026-10-18 on services/production-planning.service.js (read-only
 * against Busy). The previous version used dbo.fn_ProductionBOM, which never
 * exploded semi-finished items (it looked for a sub-recipe under the
 * component's item code instead of the BOM that produces it) and ignored
 * the BOM batch quantity; stock came from the faulty Itemwise_Stock view;
 * pending sales orders were matched to invoices by item NAME across four
 * years. Now: every recipe level, correct batch scaling, live stock that
 * matches Busy, and exact pending PO / pending sales order quantities from
 * Busy's own pending-order references.
 *
 *   GET  /products?search=     products with a recipe
 *   GET  /demand               finished goods waiting on sales orders vs stock
 *   POST /plan                 { lines: [{ bomCode, qty }], netSemiFinishedStock? }
 *                              (legacy body { itemCode: <bomCode>, targetQty } still accepted)
 */
const express = require('express');
const { getErpPool } = require('../erpDb');
const { authenticate, authorize } = require('../middleware/auth');
const planning = require('../services/production-planning.service');

const router = express.Router();
const PRODUCTION_PLANNING_ROLES = ['Admin', 'Procurement', 'Director', 'ProductionManager', 'OpsManager', 'ProductionClerk'];

router.get('/products', authenticate, authorize(...PRODUCTION_PLANNING_ROLES), async (req, res, next) => {
  try {
    res.json({ data: await planning.searchProducts(await getErpPool(), req.query.search) });
  } catch (err) { next(err); }
});

router.get('/demand', authenticate, authorize(...PRODUCTION_PLANNING_ROLES), async (req, res, next) => {
  try {
    res.json({ data: await planning.getDemand(await getErpPool()) });
  } catch (err) { next(err); }
});

router.post('/plan', authenticate, authorize(...PRODUCTION_PLANNING_ROLES), async (req, res, next) => {
  try {
    let lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length && req.body.itemCode) lines = [{ bomCode: req.body.itemCode, qty: req.body.targetQty }];
    lines = lines
      .map((l) => ({ bomCode: parseInt(l.bomCode, 10), qty: parseFloat(l.qty) }))
      .filter((l) => l.bomCode && l.qty > 0)
      .slice(0, 50);
    if (!lines.length) return res.status(400).json({ error: 'Add at least one product with a quantity greater than 0' });
    const plan = await planning.buildPlan(await getErpPool(), lines, { netSemiFinishedStock: req.body.netSemiFinishedStock !== false });
    res.json(plan);
  } catch (err) { next(err); }
});

module.exports = router;
