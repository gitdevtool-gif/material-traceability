/**
 * Requisitions Routes
 * Manages synced Busy PurIndents requisitions.
 *
 * Multi-requisition RFQs (2026-07-30): FIXED — GET / and GET /:id
 * previously joined dbo.RFQs via rfq.RequisitionId (the old 1:1 column),
 * which is NULL on every RFQ created after migration 016. That silently
 * showed RFQNumber/RFQId as null for requisitions that are actually
 * linked to a bundled RFQ. Both now join via r.RFQId = rfq.RFQId, the
 * new source of truth.
 *
 * Added GET /matching-suppliers (plural, no :id) — combined supplier
 * match across several requisitions at once, for the new "bundle into
 * one RFQ" flow. Placed BEFORE the /:id route below, same reasoning as
 * rfq.routes.js's /dispatches/search — otherwise Express would treat
 * "matching-suppliers" as a value for the :id param.
 *
 * Ops Manager approval gate (migration 021): requisitions now sync in
 * with Status = 'PendingOpsApproval' and only reach Status = 'Pending'
 * (visible here) once approved via requisition-approval.routes.js. The
 * default GET / (no explicit status filter) excludes both
 * 'PendingOpsApproval' and 'RejectedByOps' so Procurement never sees a
 * requisition that hasn't cleared that gate. An explicit ?status=
 * filter can still request either of those directly (e.g. for audit).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { syncRequisitions } = require('../../services/procurement-sync.service');
const { resolveCategoryForItemNames, resolveItemCodeLookup } = require('../../services/requisition-item-catalog.service');

const router = express.Router();
const PROC_ROLES = ['Admin', 'Procurement', 'Director'];

// ── Item reference photo upload config ──────────────────────────────────────
// Procurement can attach a reference photo (sample, packaging, spec sheet)
// to a requisition item before dispatching the RFQ — shown to suppliers in
// the email and on their tokenized web link. Separate from the supplier's
// own quote photo (rfq-public.routes.js, uploads/rfq-photos).
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'item-reference-photos');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP or HEIC images are allowed'));
    }
    cb(null, true);
  },
});

// ── GET /api/procurement/requisitions ────────────────────────────────────────
router.get('/', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const { status, search, dateFrom, dateTo, page = 1, limit = 25 } = req.query;
    const pool = await getPool();
    const request = pool.request();
    // Default (no explicit status filter) hides rows still sitting with
    // the Ops Manager — they aren't Procurement's to see yet. An explicit
    // status filter (e.g. for audit) can still request them directly.
    let where = status ? '1=1' : "r.Status NOT IN ('PendingOpsApproval','RejectedByOps')";

    if (status) {
      where += ' AND r.Status = @status';
      request.input('status', sql.VarChar(30), status);
    }
    if (search) {
      where += ' AND (r.BusyOrdNo LIKE @search OR r.MatCenter LIKE @search OR r.Warehouse LIKE @search OR r.Vehicle LIKE @search)';
      request.input('search', sql.NVarChar(100), `%${search}%`);
    }
    if (dateFrom) {
      where += ' AND r.BusyDate >= @dateFrom';
      request.input('dateFrom', sql.Date, dateFrom);
    }
    if (dateTo) {
      where += ' AND r.BusyDate <= @dateTo';
      request.input('dateTo', sql.Date, dateTo);
    }

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    request.input('offset', sql.Int, offset);
    request.input('limit',  sql.Int, parseInt(limit));

    // Count + data in parallel
    const countReq = pool.request();
    if (status)   countReq.input('status',   sql.VarChar(30),   status);
    if (search)   countReq.input('search',   sql.NVarChar(100), `%${search}%`);
    if (dateFrom) countReq.input('dateFrom', sql.Date,          dateFrom);
    if (dateTo)   countReq.input('dateTo',   sql.Date,          dateTo);

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*) AS total FROM dbo.Requisitions r WHERE ${where}`),
      request.query(`
        SELECT
          r.RequisitionId, r.BusyOrdNo, r.BusyDate, r.Warehouse, r.MatCenter,
          r.Status, r.SyncedAt, r.Notes, r.CreatedAt, r.RFQId,
          r.OrderType, r.Vehicle,
          (SELECT COUNT(*) FROM dbo.RequisitionItems ri
           WHERE ri.RequisitionId = r.RequisitionId) AS ItemCount,
          -- Items not yet sent in ANY RFQ — the real "can this still be
          -- picked for a new RFQ" signal now that RFQ linkage lives on
          -- RequisitionItems, not here. r.RFQId only shows the most
          -- recent RFQ this requisition has touched, for display.
          (SELECT COUNT(*) FROM dbo.RequisitionItems ri
           WHERE ri.RequisitionId = r.RequisitionId AND ri.RFQId IS NULL) AS AvailableItemCount,
          rfq.RFQNumber,
          (SELECT COUNT(*) FROM dbo.Quotations q
           JOIN dbo.RFQDispatches d ON d.RFQDispatchId = q.RFQDispatchId
           WHERE d.RFQId = rfq.RFQId AND q.IsWithdrawn = 0) AS QuotationCount
        FROM dbo.Requisitions r
        LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = r.RFQId
        WHERE ${where}
        ORDER BY r.BusyDate DESC, r.BusyOrdNo DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `),
    ]);

    const total = countResult.recordset[0].total;
    res.json({
      data: dataResult.recordset,
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions/stats ──────────────────────────────────
router.get('/stats', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT Status, COUNT(*) AS cnt
      FROM dbo.Requisitions
      GROUP BY Status
    `);
    const stats = { Pending: 0, RFQSent: 0, QuotesReceived: 0,
                    EvaluationPending: 0, Approved: 0, Reconciled: 0, Cancelled: 0 };
    for (const row of result.recordset) {
      stats[row.Status] = row.cnt;
    }
    res.json(stats);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions/categories ─────────────────────────────
// Distinct item categories currently in use, sourced from
// dbo.RequisitionItems.Category — which is itself populated exclusively
// from Busy ERP's authoritative PurIndents.category (see
// procurement-sync.service.js / backfill-item-categories.js). Used to
// populate the supplier "Supply Categories" dropdown so suppliers can only
// be tagged with categories that actually exist in Busy's item data.
router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT Category
      FROM dbo.RequisitionItems
      WHERE Category IS NOT NULL AND LTRIM(RTRIM(Category)) <> ''
      ORDER BY Category
    `);
    res.json(result.recordset.map(r => r.Category));
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions/matching-suppliers ─────────────────────
// Combined supplier match across SEVERAL requisitions at once (query param
// ids=1,2,3) — used by the new "bundle into one RFQ" flow on the list page,
// where staff select multiple requisitions (any factory) before dispatching
// a single combined RFQ. Same category-overlap logic as the single-id
// version below, just widened to RequisitionId IN (...).
router.get('/matching-suppliers', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) {
      return res.status(400).json({ error: 'ids query parameter is required (comma-separated requisition ids)' });
    }
    const ids = [...new Set(
      String(idsParam).split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !isNaN(n))
    )];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid requisition ids provided' });
    }

    const pool = await getPool();
    const idPlaceholders = ids.map((_, i) => `@r${i}`).join(',');
    const request = pool.request();
    ids.forEach((rid, i) => request.input(`r${i}`, sql.Int, rid));

    const result = await request.query(`
      SELECT DISTINCT
        s.SupplierId, s.SupplierCode, s.SupplierName,
        s.Phone, s.WhatsApp, s.Email, s.IsActive,
        STRING_AGG(sc.Category, ', ') AS SupplierCategories
      FROM dbo.Suppliers s
      JOIN dbo.SupplierCategories sc ON sc.SupplierId = s.SupplierId
      JOIN dbo.RequisitionItems ri ON ri.Category = sc.Category
      WHERE ri.RequisitionId IN (${idPlaceholders})
        AND s.IsActive = 1
      GROUP BY s.SupplierId, s.SupplierCode, s.SupplierName, s.Phone, s.WhatsApp, s.Email, s.IsActive
      ORDER BY s.SupplierName
    `);

    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions/:id ────────────────────────────────────
router.get('/:id', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const [reqResult, itemsResult] = await Promise.all([
      pool.request().input('id', sql.Int, id).query(`
        SELECT r.*, rfq.RFQNumber, rfq.IssuedAt, rfq.DeadlineAt, rfq.Notes AS RFQNotes
        FROM dbo.Requisitions r
        LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = r.RFQId
        WHERE r.RequisitionId = @id
      `),
      pool.request().input('id', sql.Int, id).query(`
        SELECT
          ri.RequisitionItemId, ri.RequisitionId, ri.ItemName, ri.ItemCode, ri.Qty, ri.Unit,
          ri.BusyPrice, ri.BusyAmt, ri.Category, ri.CreatedAt, ri.ReferencePhotoUrl,
          ri.RFQId, rfq.RFQNumber,
          ri.PreferredSupplierId,
          COALESCE(ps.SupplierName, ri.PreferredSupplierName) AS PreferredSupplierName,
          ri.PreferredBrand, ri.PreferredQuality
        FROM dbo.RequisitionItems ri
        LEFT JOIN dbo.RFQs rfq ON rfq.RFQId = ri.RFQId
        LEFT JOIN dbo.Suppliers ps ON ps.SupplierId = ri.PreferredSupplierId
        WHERE ri.RequisitionId = @id
        ORDER BY ri.RequisitionItemId
      `),
    ]);

    if (reqResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Requisition not found' });
    }

    const req_ = reqResult.recordset[0];
    req_.items = itemsResult.recordset;
    res.json(req_);
  } catch (err) { next(err); }
});

// ── PATCH /api/procurement/requisitions/:id/items/:itemId ────────────────────
// Procurement corrects an item's name and/or requested Qty BEFORE it goes
// out on any RFQ (RFQId IS NULL). Once dispatched, the separate
// PATCH /api/procurement/rfq/:rfqId/items/:itemId handles corrections
// (it also reports suppliers who already quoted). If the new name typed
// is a bare code that has an ItemCodeLookup mapping, it's resolved to the
// real name here too, so a code can't be re-introduced by hand.
router.patch('/:id/items/:itemId', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const requisitionId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);

    const hasQty      = req.body.qty !== undefined && req.body.qty !== null && req.body.qty !== '';
    const hasItemName = req.body.itemName !== undefined && req.body.itemName !== null;
    if (!hasQty && !hasItemName) {
      return res.status(400).json({ error: 'Provide qty and/or itemName to update' });
    }

    let qty = null;
    if (hasQty) {
      qty = parseFloat(req.body.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'qty must be a positive number' });
      }
    }

    let itemName = null;
    let itemCode = null;
    let lookupCategory = null;
    if (hasItemName) {
      itemName = String(req.body.itemName).trim();
      if (!itemName) {
        return res.status(400).json({ error: 'itemName cannot be blank' });
      }
      if (itemName.length > 200) {
        return res.status(400).json({ error: 'itemName must be 200 characters or fewer' });
      }
      const codeHit = (await resolveItemCodeLookup([itemName])).get(itemName.toLowerCase());
      if (codeHit) {
        itemCode = itemName;
        itemName = codeHit.itemName;
        lookupCategory = codeHit.category;
      }
    }

    const pool = await getPool();
    const current = await pool.request()
      .input('requisitionId', sql.Int, requisitionId)
      .input('itemId', sql.Int, itemId)
      .query(`
        SELECT ri.RequisitionItemId, ri.ItemName, ri.ItemCode, ri.Qty, ri.Category, ri.RFQId, r.Status
        FROM dbo.RequisitionItems ri
        JOIN dbo.Requisitions r ON r.RequisitionId = ri.RequisitionId
        WHERE ri.RequisitionId = @requisitionId AND ri.RequisitionItemId = @itemId
      `);
    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Item not found on this requisition' });
    }
    const item = current.recordset[0];
    if (['Cancelled', 'Reconciled'].includes(item.Status)) {
      return res.status(400).json({ error: `Cannot edit items on a ${item.Status.toLowerCase()} requisition` });
    }
    if (item.RFQId) {
      return res.status(409).json({ error: 'This item has already been sent on an RFQ — edit it from that RFQ section instead' });
    }

    const qtyChanged  = hasQty && qty !== Number(item.Qty);
    const nameChanged = hasItemName && itemName !== item.ItemName;

    if (qtyChanged || nameChanged) {
      const update = pool.request().input('itemId', sql.Int, itemId);
      const setClauses = [];
      if (qtyChanged) {
        update.input('qty', sql.Float, qty);
        setClauses.push('Qty = @qty');
      }
      if (nameChanged) {
        update.input('itemName', sql.NVarChar(200), itemName);
        update.input('itemCode', sql.NVarChar(50), itemCode);
        setClauses.push('ItemName = @itemName', 'ItemCode = @itemCode');
        if (lookupCategory && !item.Category) {
          update.input('category', sql.NVarChar(100), lookupCategory);
          setClauses.push('Category = @category');
        }
      }
      await update.query(`UPDATE dbo.RequisitionItems SET ${setClauses.join(', ')} WHERE RequisitionItemId = @itemId`);
    }

    const updated = await pool.request().input('itemId', sql.Int, itemId)
      .query('SELECT RequisitionItemId, ItemName, ItemCode, Qty, Unit, Category FROM dbo.RequisitionItems WHERE RequisitionItemId = @itemId');
    res.json(updated.recordset[0]);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/requisitions/:id/items/:itemId/photo ───────────────
// Procurement attaches a reference photo to a single requisition item —
// shown to suppliers in the RFQ email and on their tokenized web link.
// Replaces any previously-attached photo for that item (old file removed).
router.post('/:id/items/:itemId/photo', authenticate, authorize('Admin', 'Procurement'), (req, res, next) => {
  upload.single('photo')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.message || 'Upload failed' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No photo received' });
      }

      const requisitionId = parseInt(req.params.id, 10);
      const itemId = parseInt(req.params.itemId, 10);
      const pool = await getPool();

      const itemCheck = await pool.request()
        .input('requisitionId', sql.Int, requisitionId)
        .input('itemId', sql.Int, itemId)
        .query(`
          SELECT RequisitionItemId, ReferencePhotoUrl FROM dbo.RequisitionItems
          WHERE RequisitionId = @requisitionId AND RequisitionItemId = @itemId
        `);

      if (itemCheck.recordset.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Item not found on this requisition' });
      }

      const priorUrl = itemCheck.recordset[0].ReferencePhotoUrl;
      const photoUrl = `/uploads/item-reference-photos/${req.file.filename}`;

      await pool.request()
        .input('itemId', sql.Int, itemId)
        .input('photoUrl', sql.NVarChar(500), photoUrl)
        .query('UPDATE dbo.RequisitionItems SET ReferencePhotoUrl = @photoUrl WHERE RequisitionItemId = @itemId');

      if (priorUrl) {
        const priorPath = path.join(__dirname, '..', '..', priorUrl.replace(/^\/uploads\//, 'uploads/'));
        fs.unlink(priorPath, () => {});
      }

      res.status(201).json({ photoUrl });
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      next(err);
    }
  });
});

// ── DELETE /api/procurement/requisitions/:id/items/:itemId/photo ─────────────
router.delete('/:id/items/:itemId/photo', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const requisitionId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const pool = await getPool();

    const itemCheck = await pool.request()
      .input('requisitionId', sql.Int, requisitionId)
      .input('itemId', sql.Int, itemId)
      .query(`
        SELECT ReferencePhotoUrl FROM dbo.RequisitionItems
        WHERE RequisitionId = @requisitionId AND RequisitionItemId = @itemId
      `);

    if (itemCheck.recordset.length === 0) {
      return res.status(404).json({ error: 'Item not found on this requisition' });
    }

    const priorUrl = itemCheck.recordset[0].ReferencePhotoUrl;
    await pool.request()
      .input('itemId', sql.Int, itemId)
      .query('UPDATE dbo.RequisitionItems SET ReferencePhotoUrl = NULL WHERE RequisitionItemId = @itemId');

    if (priorUrl) {
      const priorPath = path.join(__dirname, '..', '..', priorUrl.replace(/^\/uploads\//, 'uploads/'));
      fs.unlink(priorPath, () => {});
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions/:id/matching-suppliers ─────────────────
// Returns suppliers whose categories overlap with items in this requisition
router.get('/:id/matching-suppliers', authenticate, authorize(...PROC_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const result = await pool.request().input('id', sql.Int, id).query(`
      SELECT DISTINCT
        s.SupplierId, s.SupplierCode, s.SupplierName,
        s.Phone, s.WhatsApp, s.Email, s.IsActive,
        STRING_AGG(sc.Category, ', ') AS SupplierCategories
      FROM dbo.Suppliers s
      JOIN dbo.SupplierCategories sc ON sc.SupplierId = s.SupplierId
      JOIN dbo.RequisitionItems ri ON ri.Category = sc.Category
      WHERE ri.RequisitionId = @id
        AND s.IsActive = 1
      GROUP BY s.SupplierId, s.SupplierCode, s.SupplierName, s.Phone, s.WhatsApp, s.Email, s.IsActive
      ORDER BY s.SupplierName
    `);

    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/requisitions/:id/recategorize ──────────────────────
// Re-applies Busy ERP's authoritative item category (dbo.PurIndents.category)
// to all items in a requisition, persisting the result so the
// matching-suppliers join works correctly.
//
// Busy's category is mandatory and is the sole source of truth — there is
// no local pattern-matching fallback. If Busy shows more than one category
// for the same item name across different rows (a data inconsistency in
// Busy itself), that item is left unchanged and reported as ambiguous
// rather than guessed at. If an item name has no category anywhere in
// Busy's current PurIndents data, it is also left unchanged and reported.
router.post('/:id/recategorize', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();

    const items = await pool.request()
      .input('id', sql.Int, id)
      // Busy categorises by its own (raw code) name, so use ItemCode for
      // items resolved via ItemCodeLookup.
      .query('SELECT RequisitionItemId, COALESCE(ItemCode, ItemName) AS ItemName, Category FROM dbo.RequisitionItems WHERE RequisitionId = @id');

    if (items.recordset.length === 0) {
      return res.json({ ok: true, updated: 0, skippedAmbiguous: 0, noMapping: 0, total: 0 });
    }

    const itemNames = [...new Set(items.recordset.map(i => String(i.ItemName).trim()))];
    const categoryByItemName = await resolveCategoryForItemNames(itemNames);

    let updated = 0;
    let skippedAmbiguous = 0;
    let noMapping = 0;

    for (const item of items.recordset) {
      const itemName = String(item.ItemName).trim();
      const erpCategory = categoryByItemName.get(itemName);

      if (!erpCategory) {
        // Either no historical mapping at all, or the mapping was
        // ambiguous (multiple different categories seen for this item
        // name in Busy) — resolveCategoryForItemNames() already dropped
        // ambiguous entries, so both cases land here as "can't resolve".
        noMapping++;
        continue;
      }

      if (item.Category === erpCategory) {
        continue; // already correct, no write needed
      }

      await pool.request()
        .input('itemId',   sql.Int,           item.RequisitionItemId)
        .input('category', sql.NVarChar(100), erpCategory)
        .query('UPDATE dbo.RequisitionItems SET Category = @category WHERE RequisitionItemId = @itemId');

      updated++;
    }

    res.json({
      ok: true,
      updated,
      skippedAmbiguous,
      noMapping,
      total: items.recordset.length,
    });
  } catch (err) { next(err); }
});

// ── POST /api/procurement/requisitions/:id/quick-rfq ──────────────────────────
// Fast path for when Procurement already has a supplier's price in hand
// (phoned in, WhatsApp, an old email — obtained outside the system) and
// doesn't need to actually dispatch an RFQ and wait for a response. Creates
// just the RFQ + a single dispatch for the chosen supplier — no email is
// sent (Channel is a neutral placeholder; the dispatch exists only because
// dbo.Quotations.RFQDispatchId requires one). The frontend then sends
// Procurement straight to the existing Capture Quotation form
// (/procurement/quotations?rfqId=&dispatchId=) to key in the known price,
// which already flips the requisition to 'QuotesReceived' on save — from
// there it shows up in the Director's evaluation queue exactly like any
// other RFQ, unchanged.
//
// Same eligibility rules as the normal "Create Combined RFQ" flow
// (rfq.routes.js POST /): requisition must not already be linked to an
// RFQ, and must not be Cancelled.
async function generateRFQNumber(pool) {
  const year = new Date().getFullYear();
  const result = await pool.request()
    .input('prefix', sql.VarChar(20), `RFQ-${year}-%`)
    .query(`
      SELECT TOP 1
        ISNULL(MAX(TRY_CAST(RIGHT(RFQNumber, 4) AS INT)), 0) AS MaxNum
      FROM dbo.RFQs
      WHERE RFQNumber LIKE @prefix
    `);
  const next = (result.recordset[0].MaxNum || 0) + 1;
  return `RFQ-${year}-${String(next).padStart(4, '0')}`;
}

router.post('/:id/quick-rfq', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const supplierId = parseInt(req.body.supplierId, 10);
    if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });

    const pool = await getPool();

    const reqCheck = await pool.request().input('id', sql.Int, id).query(
      'SELECT RequisitionId, Status, BusyOrdNo FROM dbo.Requisitions WHERE RequisitionId = @id'
    );
    if (reqCheck.recordset.length === 0) return res.status(404).json({ error: 'Requisition not found' });
    const requisition = reqCheck.recordset[0];
    if (requisition.Status === 'Cancelled') return res.status(400).json({ error: 'Cannot create an RFQ for a cancelled requisition' });

    // Only items not yet sent in ANY RFQ are eligible — a requisition can
    // be partially committed to an earlier RFQ and still have some items
    // left over for this one.
    const availableItems = await pool.request().input('id', sql.Int, id).query(
      'SELECT RequisitionItemId FROM dbo.RequisitionItems WHERE RequisitionId = @id AND RFQId IS NULL'
    );
    if (availableItems.recordset.length === 0) {
      return res.status(409).json({ error: `Every item on ${requisition.BusyOrdNo} is already part of an RFQ` });
    }
    const availableItemIds = availableItems.recordset.map((r) => r.RequisitionItemId);

    const supplierCheck = await pool.request().input('id', sql.Int, supplierId).query(
      'SELECT SupplierId, SupplierName, IsActive FROM dbo.Suppliers WHERE SupplierId = @id'
    );
    if (supplierCheck.recordset.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    if (!supplierCheck.recordset[0].IsActive) return res.status(400).json({ error: 'Supplier is not active' });

    const rfqNumber = await generateRFQNumber(pool);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const rfqResult = await new sql.Request(transaction)
        .input('RFQNumber', sql.VarChar(30), rfqNumber)
        .input('IssuedAt', sql.DateTime2, new Date())
        .input('IssuedByUserId', sql.Int, req.user.userId)
        .input('Notes', sql.NVarChar(1000), 'Quote already in hand — RFQ created directly from Requisitions page, not dispatched electronically.')
        .query(`
          INSERT INTO dbo.RFQs (RequisitionId, RFQNumber, IssuedAt, IssuedByUserId, Notes)
          OUTPUT INSERTED.RFQId
          VALUES (NULL, @RFQNumber, @IssuedAt, @IssuedByUserId, @Notes)
        `);
      const rfqId = rfqResult.recordset[0].RFQId;

      // Link exactly the currently-available items — not the whole
      // requisition, which may already have other items committed to an
      // earlier RFQ.
      const itemPlaceholders = availableItemIds.map((_, i) => `@i${i}`).join(',');
      const linkItemsReq = new sql.Request(transaction).input('rfqId', sql.Int, rfqId);
      availableItemIds.forEach((iid, i) => linkItemsReq.input(`i${i}`, sql.Int, iid));
      await linkItemsReq.query(`
        UPDATE dbo.RequisitionItems SET RFQId = @rfqId WHERE RequisitionItemId IN (${itemPlaceholders})
      `);

      await new sql.Request(transaction)
        .input('id', sql.Int, id)
        .input('rfqId', sql.Int, rfqId)
        .query(`
          UPDATE dbo.Requisitions
          SET RFQId = @rfqId,
              Status = CASE WHEN Status = 'Pending' THEN 'RFQSent' ELSE Status END,
              UpdatedAt = GETUTCDATE()
          WHERE RequisitionId = @id
        `);

      const dispatchResult = await new sql.Request(transaction)
        .input('RFQId', sql.Int, rfqId)
        .input('SupplierId', sql.Int, supplierId)
        .input('SentAt', sql.DateTime2, new Date())
        .input('SentByUserId', sql.Int, req.user.userId)
        .input('DispatchNotes', sql.NVarChar(500), 'Quote captured directly — not sent via email/portal')
        .query(`
          INSERT INTO dbo.RFQDispatches (RFQId, SupplierId, Channel, SentAt, SentByUserId, DispatchNotes)
          OUTPUT INSERTED.RFQDispatchId
          VALUES (@RFQId, @SupplierId, 'phone', @SentAt, @SentByUserId, @DispatchNotes)
        `);
      const dispatchId = dispatchResult.recordset[0].RFQDispatchId;

      await transaction.commit();
      res.status(201).json({ rfqId, rfqNumber, dispatchId });
    } catch (trxErr) {
      await transaction.rollback();
      throw trxErr;
    }
  } catch (err) { next(err); }
});

// ── POST /api/procurement/requisitions/sync ──────────────────────────────────
// Manual trigger for the sync job
router.post('/sync', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const result = await syncRequisitions();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: 'Sync failed — check ERP connectivity', detail: err.message });
  }
});

// ── PATCH /api/procurement/requisitions/:id/cancel ───────────────────────────
router.patch('/:id/cancel', authenticate, authorize('Admin', 'Procurement'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request()
      .input('id',    sql.Int,           id)
      .input('notes', sql.NVarChar(1000), req.body.notes || null)
      .query(`
        UPDATE dbo.Requisitions
        SET Status = 'Cancelled', Notes = @notes, UpdatedAt = GETUTCDATE()
        WHERE RequisitionId = @id AND Status NOT IN ('Reconciled','Approved')
      `);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;