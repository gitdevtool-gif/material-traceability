/**
 * System Settings (2026-10-27) — Admin reads and changes the settings in
 * settings.service.js from the System Settings page.
 */
const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/audit.service');
const { listSettings, setSetting } = require('../services/settings.service');

const router = express.Router();

// ── GET /api/settings ──
router.get('/', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    res.json(await listSettings());
  } catch (err) { next(err); }
});

// ── PUT /api/settings/:key  Body: { value } ──
router.put('/:key', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { old, value } = await setSetting(req.params.key, req.body.value, req.user.userId);
    writeAuditLog({
      entityType: 'AppSetting', entityId: req.params.key,
      action: 'Update', userId: req.user.userId,
      oldValues: { value: old }, newValues: { value },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ key: req.params.key, value });
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
