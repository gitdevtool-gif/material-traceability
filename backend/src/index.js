const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./logger');
const { getPool, closePool } = require('./db');
const { closeErpPool } = require('./erpDb');
const { requestId, requestLogger, errorHandler } = require('./middleware/common');

// Route modules
const authRoutes = require('./routes/auth.routes');
const entriesRoutes = require('./routes/entries.routes');
const weighbridgeRoutes = require('./routes/weighbridge.routes');
const qaRoutes = require('./routes/qa.routes');
const grnRoutes = require('./routes/grn.routes');
const rejectionRoutes = require('./routes/rejection.routes');
const suppliersRoutes = require('./routes/suppliers.routes');
const materialsRoutes = require('./routes/materials.routes');
const locationsRoutes = require('./routes/locations.routes');
const reportsRoutes = require('./routes/reports.routes');
const erpRoutes = require('./routes/erp.routes');
const opsManagerRoutes = require('./routes/opsmanager.routes');
const busyReceivingRoutes = require('./routes/busy-receiving.routes');
const stockRoutes = require('./routes/stock.routes');
const traceRoutes = require('./routes/trace.routes');

// Procurement module
const procItemCategoryRoutes   = require('./routes/procurement/item-category-map.routes');
const procRequisitionsRoutes   = require('./routes/procurement/requisitions.routes');
const procRFQRoutes            = require('./routes/procurement/rfq.routes');
const procQuotationsRoutes     = require('./routes/procurement/quotations.routes');
const procEvaluationRoutes     = require('./routes/procurement/evaluation.routes');
const procReconciliationRoutes = require('./routes/procurement/reconciliation.routes');
// "LPO raised in Busy" marking + listing (2026-10-15) — read-only on Busy.
const procBusyLpoRoutes        = require('./routes/procurement/busy-lpo.routes');
const procReorderRoutes        = require('./routes/Reorder.routes');
const procFGReorderRoutes      = require('./routes/procurement/fg-reorder.routes');
const rfqPublicRoutes          = require('./routes/rfq-public.routes');
// Ops Manager approval gate on synced Requisitions — replaces the
// scrapped Production Requests module (see migration 020/021). Every
// requisition synced from Busy lands with Status = 'PendingOpsApproval'
// and is invisible to Procurement until reviewed here.
const requisitionApprovalRoutes = require('./routes/procurement/requisition-approval.routes');
// In-system purchase indent creation (2026-09-15) — replaces the Busy
// PurIndents sync as the way new requisitions enter this system.
const requisitionCreateRoutes = require('./routes/procurement/requisition-create.routes');
const centralStoresRoutes     = require('./routes/procurement/central-stores.routes');
// Code -> real item name vlookup (2026-09-15) — some Busy stock items
// only expose a bare product code; Admin manages the mapping here.
const itemCodeLookupRoutes    = require('./routes/procurement/item-code-lookup.routes');

// Production module
const procProductionPlanningRoutes = require('./routes/Production-planning.routes');
const agingRoutes                  = require('./routes/aging.routes');

const { startSyncJob, stopSyncJob } = require('./services/procurement-sync.service');
const { startReorderSyncJob, stopReorderSyncJob } = require('./services/reorder-sync.service');
const { startFGReorderSyncJob, stopFGReorderSyncJob } = require('./services/fg-reorder-sync.service');
const { startAgingSyncJob, stopAgingSyncJob } = require('./services/aging-sync.service');

const app = express();

// Trust the first hop proxy (e.g. nginx/IIS in front of Node, or the
// Cloudflare Tunnel `cloudflared` process running on localhost that
// terminates the public https://rfq.njorocanning.co.ke traffic and
// forwards it to http://localhost:4008). This lets express-rate-limit
// safely read the client IP from X-Forwarded-For / CF-Connecting-IP
// without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Do NOT set to
// `true` — that would trust the entire forwarded chain and let a
// client spoof its own IP via a crafted X-Forwarded-For header.
app.set('trust proxy', 1);

// ── Security & parsing ──
app.use(helmet({
  contentSecurityPolicy: false,
  // Cloudflare terminates TLS, so we're behind a proxy — allow cross-origin
  // resources to be embedded (needed for the public supplier RFQ page).
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// CORS — allow LAN dev origins, the LAN production host, and the public
// Cloudflare-tunneled hostname used by external suppliers.
const ALLOWED_ORIGINS = [
  'http://192.168.1.9:3008',
  'http://192.168.1.9:4008',
  'http://192.168.1.9:3001',
  'http://localhost:3008',
  'http://localhost:4008',
  'http://localhost:3001',
  'http://localhost:3000',
  'https://rfq.njorocanning.co.ke',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / server-to-server / curl (no Origin header)
    if (!origin) return cb(null, true);
    // Normalize away any trailing slash before comparing — some clients
    // send Origin with a trailing slash (e.g. "http://localhost:4008/"),
    // which would otherwise fail an exact-match check against the list.
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (ALLOWED_ORIGINS.includes(normalizedOrigin)) return cb(null, true);
    // Also allow any subdomain of njorocanning.co.ke over https
    if (/^https:\/\/[a-z0-9-]+\.njorocanning\.co\.ke$/i.test(normalizedOrigin)) {
      return cb(null, true);
    }
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ── Observability ──
app.use(requestId);
app.use(requestLogger);

// ── Health check ──
app.get('/api/health', async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ── API routes ──
app.use('/api/auth', authRoutes);
app.use('/api/entries', entriesRoutes);
app.use('/api/weighbridge', weighbridgeRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/grn', grnRoutes);
app.use('/api/rejections', rejectionRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/erp', erpRoutes);
app.use('/api/ops-approval', opsManagerRoutes);
app.use('/api/busy-receiving', busyReceivingRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/trace', traceRoutes);

// ── Procurement API routes ──
app.use('/api/procurement/item-categories',  procItemCategoryRoutes);
app.use('/api/procurement/requisitions',     procRequisitionsRoutes);
app.use('/api/procurement/rfq',              procRFQRoutes);
app.use('/api/procurement/quotations',       procQuotationsRoutes);
app.use('/api/procurement/evaluation',       procEvaluationRoutes);
app.use('/api/procurement/reconciliation',   procReconciliationRoutes);
app.use('/api/procurement/busy-lpo',         procBusyLpoRoutes);
app.use('/api/procurement/reorder',          procReorderRoutes);
app.use('/api/procurement/fg-reorder',       procFGReorderRoutes);
// Requisition Ops-Approval — gates Busy-synced requisitions before
// Procurement ever sees them. Consumed by OpsManagerApprovalPage's
// second tab ("Requisition Approval").
app.use('/api/procurement/requisition-approval', requisitionApprovalRoutes);
app.use('/api/procurement/requisitions-create', requisitionCreateRoutes);
app.use('/api/procurement/central-stores', centralStoresRoutes);
app.use('/api/procurement/item-code-lookup', itemCodeLookupRoutes);

// ── Production API routes ──
// Mounted at the same /api/procurement/production-planning path the
// frontend's ProductionPlanningPage already calls. The route file itself
// lives at routes/Production-planning.routes.js (directly under routes/,
// not routes/procurement/) — only the URL prefix stays under procurement.
app.use('/api/procurement/production-planning', procProductionPlanningRoutes);

// Aging Analysis — mounted at /api/production/aging to match the frontend
// nav path (/production/aging-analysis) and what AgingAnalysis.jsx calls.
// Route file lives at routes/aging.routes.js, directly under routes/, same
// convention as Production-planning.routes.js above.
app.use('/api/production/aging', agingRoutes);

// ── Uploaded photos (RFQ item reference photos + supplier quote photos) ──
// Both rfq-public.routes.js (supplier-submitted item photos, under
// uploads/rfq-photos) and requisitions.routes.js (procurement-attached
// item reference photos, under uploads/item-reference-photos) save files
// under backend/src/uploads/** and return a `/uploads/...`-relative URL.
// Without this static mount those URLs 404 — nothing was ever serving
// this directory publicly.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '30d' }));

// ── Public supplier RFQ link (separate stricter rate limiter) ──
const rfqPublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/rfq', rfqPublicLimiter, rfqPublicRoutes);

// ── Serve React frontend in production ──
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { maxAge: '7d', etag: true }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Error handler ──
app.use(errorHandler);

// ── Start ──
const PORT = config.port;
const server = app.listen(PORT, () => {
  logger.info(`Material Traceability API running on port ${PORT}`);
  // Start procurement sync polling after server is up
  startSyncJob();
  startReorderSyncJob();
  startFGReorderSyncJob();
  startAgingSyncJob();
});
server.timeout = 30000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down…');
  stopSyncJob();
  stopReorderSyncJob();
  stopFGReorderSyncJob();
  stopAgingSyncJob();
  server.close();
  await closePool();
  await closeErpPool();
  process.exit(0);
});
process.on('SIGINT', async () => {
  stopSyncJob();
  stopReorderSyncJob();
  stopFGReorderSyncJob();
  stopAgingSyncJob();
  server.close();
  await closePool();
  await closeErpPool();
  process.exit(0);
});

module.exports = app;