/**
 * Requisition Create Routes (in-system purchase indent creation)
 *
 * Replaces Busy's PurIndents as the way new requisitions enter this
 * system (2026-09-15) — see add-manual-requisition-creation.sql.
 * FactoryReceiving clerks raise a requisition here, picking items from
 * a company-wide item catalog (see requisition-item-catalog.service.js —
 * NOT filtered to the clerk's own Mat Centre as of 2026-09-16, so an F1
 * clerk can still request an item only ever stocked at Workshop) and
 * optionally naming a preferred supplier + brand/quality for
 * Procurement's information. A clerk is locked to exactly one MatCenter
 * for the REQUISITION itself (Users.AssignedMatCenter, set by Admin) —
 * never client-supplied, always read off the authenticated user
 * server-side — but that lock no longer restricts which items they can
 * pick.
 *
 * Admin has overall access (2026-09-15): unlike a clerk, Admin isn't
 * locked to one Mat Centre — they can raise a requisition for ANY of
 * them, picked per-request (see resolveMatCenter below and GET
 * /mat-centers), matching Admin's "full system access" everywhere else
 * in this app.
 *
 * What happens after submit is NOT decided here: every new requisition
 * lands in 'PendingCentralStoresApproval' and is picked up by
 * central-stores.routes.js, which hands off to the existing (unchanged)
 * Ops Manager gate for factory MatCenters, or straight to 'Pending' for
 * everything else — exactly the same downstream rule Busy-synced
 * requisitions have always followed.
 */
const express = require('express');
const { getPool, sql } = require('../../db');
const { authenticate, authorize } = require('../../middleware/auth');
const { getItemOptions, getMatCenterOptions, normalizeBusyMatCenter, resolveCategoryForItemNames, resolveItemCodeLookup } = require('../../services/requisition-item-catalog.service');
const { matCenterRequiresOpsApproval } = require('../../services/procurement-sync.service');
const { FUEL_ITEMS, isTransport, fuelItemName, listVehicles, resolveVehicle } = require('../../services/fuel-order.service');

const router = express.Router();
const CREATE_ROLES = ['FactoryReceiving', 'StoreReceiving', 'Admin'];
// Central Stores raising for themselves (2026-09-21) is always against
// this fixed Mat Centre — matches the real "CENTRAL STORES" value already
// used across live Requisitions rows. Unlike a FactoryReceiving clerk,
// Central Stores has no per-user AssignedMatCenter to look up (there's
// only ever one Central Stores), so this is a constant, not a lookup.
const CENTRAL_STORES_MAT_CENTER = 'CENTRAL STORES';
// Fixed unit-of-measure picklist (2026-09-21) — the clerk specifies which
// unit the qty is in (a bare number was ambiguous for anything not
// counted in pieces). Kept as a short fixed list rather than an
// Admin-managed table since the business only asked for a handful
// (Set and Rim added 2026-09-30).
const UNITS = ['Kgs', 'Pcs', 'Metres', 'Litres', 'Set', 'Rim'];

// Looked up fresh per request rather than trusting a JWT claim — if Admin
// reassigns a clerk's MatCenter, that must take effect immediately, not
// only after the clerk's token is next refreshed.
async function getAssignedMatCenter(pool, userId) {
  const result = await pool.request().input('id', sql.Int, userId).query(
    'SELECT AssignedMatCenter FROM dbo.Users WHERE UserId = @id'
  );
  return result.recordset[0]?.AssignedMatCenter || null;
}

// A FactoryReceiving clerk is always forced onto their own AssignedMatCenter
// — a client-supplied value is ignored for them, preserving the "locked to
// one department" security boundary. StoreReceiving (Central Stores,
// 2026-09-21) is likewise always forced onto the fixed CENTRAL_STORES_MAT_CENTER
// constant — a client-supplied value is ignored for them too. Admin has no
// such lock and instead picks any Mat Centre per-request (from GET
// /mat-centers); returns null if Admin didn't supply one, which callers
// turn into a clear 400.
//
// Whatever the source, the result is checked against Busy's Material Centres
// (2026-10-18) and returned in Busy's exact spelling, so the LPO raised later
// never fails on an unknown store. A name Busy doesn't have throws a 400.
async function resolveMatCenter(pool, req, requestedMatCenter) {
  let name;
  if (req.user.role === 'Admin') {
    name = requestedMatCenter ? String(requestedMatCenter).trim() : null;
  } else if (req.user.role === 'StoreReceiving') {
    name = CENTRAL_STORES_MAT_CENTER;
  } else {
    name = await getAssignedMatCenter(pool, req.user.userId);
  }
  if (!name) return null;
  const busyName = await normalizeBusyMatCenter(name);
  if (!busyName) {
    const err = new Error(req.user.role === 'Admin'
      ? `"${name}" is not a Material Centre in Busy — pick one from the list.`
      : `Your assigned Mat Centre "${name}" is not a Material Centre in Busy — ask Admin to set the correct one in User Management.`);
    err.status = 400;
    throw err;
  }
  return busyName;
}

async function generateRequisitionNo(transaction) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const result = await new sql.Request(transaction)
    .input('seqType', sql.VarChar(20), 'REQ')
    .input('seqDate', sql.Date, new Date())
    .query(`
      MERGE dbo.NumberSequences AS tgt
      USING (SELECT @seqType AS SequenceType, @seqDate AS SequenceDate) AS src
        ON tgt.SequenceType = src.SequenceType AND tgt.SequenceDate = src.SequenceDate
      WHEN MATCHED THEN UPDATE SET LastNumber = tgt.LastNumber + 1
      WHEN NOT MATCHED THEN INSERT (SequenceType, SequenceDate, LastNumber) VALUES (src.SequenceType, src.SequenceDate, 1)
      OUTPUT INSERTED.LastNumber;
    `);
  const seq = result.recordset[0].LastNumber;
  return `REQ-${today}-${String(seq).padStart(4, '0')}`;
}

// ── GET /api/procurement/requisitions-create/mat-centers ─────────────────────
// Admin-only in practice (a FactoryReceiving clerk has nothing to pick —
// they're locked to their own AssignedMatCenter) — every Mat Centre Busy
// tracks stock against, for Admin's Mat Centre picker.
router.get('/mat-centers', authenticate, authorize(...CREATE_ROLES), async (req, res, next) => {
  try {
    const matCenters = await getMatCenterOptions();
    res.json(matCenters);
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions-create/item-options ───────────────────
// The item catalog is company-wide (2026-09-16) — NOT filtered to the
// requesting clerk's own Mat Centre, since a clerk at one factory can
// legitimately need an item only ever stocked at another (e.g. an F1
// clerk requesting an engineering item that's only ever stocked at
// Workshop). matCenter is still resolved and returned here because the
// REQUISITION itself (header, routing, approval gates) stays locked to
// the clerk's own Mat Centre — only the item list is unscoped.
router.get('/item-options', authenticate, authorize(...CREATE_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const matCenter = await resolveMatCenter(pool, req, req.query.matCenter);
    if (!matCenter) {
      return res.status(400).json({
        error: req.user.role === 'Admin'
          ? 'Select a Mat Centre first'
          : 'Your account has no assigned Mat Centre yet — contact Admin to set one before raising a requisition.',
      });
    }
    const items = await getItemOptions();
    // Transport also picks a vehicle and can raise fuel orders (2026-10-19).
    const transport = isTransport(matCenter);
    res.json({
      matCenter,
      items,
      isTransport: transport,
      fuelItems: transport ? Object.entries(FUEL_ITEMS).map(([itemName, label]) => ({ itemName, label })) : [],
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── GET /api/procurement/requisitions-create/vehicles ────────────────────────
// Busy's Transport cost centres (vehicles), for Transport's vehicle dropdown.
router.get('/vehicles', authenticate, authorize(...CREATE_ROLES), async (req, res, next) => {
  try {
    res.json(await listVehicles());
  } catch (err) { next(err); }
});

// ── GET /api/procurement/requisitions-create/units ───────────────────────────
router.get('/units', authenticate, authorize(...CREATE_ROLES), async (req, res) => {
  res.json(UNITS);
});

// ── GET /api/procurement/requisitions-create/suppliers ───────────────────────
// Active suppliers, for the preferred-supplier dropdown.
router.get('/suppliers', authenticate, authorize(...CREATE_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(
      'SELECT SupplierId, SupplierName, SupplierCode FROM dbo.Suppliers WHERE IsActive = 1 ORDER BY SupplierName'
    );
    res.json(result.recordset);
  } catch (err) { next(err); }
});

// ── POST /api/procurement/requisitions-create ─────────────────────────────────
// Body: { items: [{ itemName, qty, preferredSupplierId?, preferredSupplierName?, preferredBrand?, preferredQuality? }] }
router.post('/', authenticate, authorize(...CREATE_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const matCenter = await resolveMatCenter(pool, req, req.body.matCenter);
    if (!matCenter) {
      return res.status(400).json({
        error: req.user.role === 'Admin'
          ? 'matCenter is required'
          : 'Your account has no assigned Mat Centre yet — contact Admin to set one before raising a requisition.',
      });
    }

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Transport (2026-10-19): the order is raised for a vehicle (a Busy
    // Transport cost centre) and posted to that vehicle's Busy store. A fuel
    // order — only fuel items — may have 0 litres (not known yet) but needs
    // the unit price; it skips review and goes straight to Procurement.
    const transport = isTransport(matCenter);
    const fuelLines = items.filter((it) => fuelItemName(it.itemName));
    const isFuelOrder = transport && fuelLines.length > 0;
    if (isFuelOrder && fuelLines.length !== items.length) {
      return res.status(400).json({ error: 'Raise fuel as its own order — other items go on a separate order.' });
    }
    let vehicle = null;
    if (transport && req.body.vehicle) {
      vehicle = await resolveVehicle(req.body.vehicle);
      if (!vehicle) return res.status(400).json({ error: `"${req.body.vehicle}" is not a Transport vehicle (cost centre) in Busy.` });
    }
    if (isFuelOrder && !vehicle) {
      return res.status(400).json({ error: 'Choose the vehicle the fuel is for.' });
    }
    const orderMatCenter = vehicle ? vehicle.store : matCenter;

    for (const it of items) {
      if (!it.itemName || !String(it.itemName).trim()) {
        return res.status(400).json({ error: 'Every item needs a name' });
      }
      const qty = parseFloat(it.qty);
      if (isFuelOrder) {
        if (!Number.isFinite(qty) || qty < 0) {
          return res.status(400).json({ error: `Item "${it.itemName}": litres must be 0 or more` });
        }
        const price = parseFloat(it.unitPrice);
        if (!Number.isFinite(price) || price <= 0) {
          return res.status(400).json({ error: `Item "${it.itemName}": enter the unit price per litre` });
        }
        it.unit = 'Litres';
      } else if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: `Item "${it.itemName}": qty must be a positive number` });
      }
      if (!UNITS.includes(it.unit)) {
        return res.status(400).json({ error: `Item "${it.itemName}": unit must be one of ${UNITS.join(', ')}` });
      }
    }

    // Server-side re-check: every requested item name must actually exist
    // in the company-wide item catalog — the client dropdown is a
    // convenience, not the source of truth. Not scoped to this clerk's own
    // MatCenter (2026-09-16): the catalog itself is company-wide now, so
    // an item stocked only at another Mat Centre is still valid to request.
    const validItems = await getItemOptions();
    const validItemsByLowerName = new Map(validItems.map((v) => [String(v.Name).trim().toLowerCase(), v]));
    const unknown = items.filter((it) => !validItemsByLowerName.has(String(it.itemName).trim().toLowerCase()));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `Item(s) not found: ${unknown.map((it) => it.itemName).join(', ')}`,
      });
    }
    // Category straight off the catalog is used first; only items with no
    // category there fall through to the broader historical-PurIndents
    // lookup below.
    const categoryFromStockByLowerName = new Map(
      validItems
        .filter((v) => v.category && String(v.category).trim())
        .map((v) => [String(v.Name).trim().toLowerCase(), String(v.category).trim()])
    );

    // Resolve suggested-supplier-by-id names up front (validates the id
    // and lets us store the resolved name too, same convenience the RFQ
    // side already gives Procurement elsewhere in this system).
    const supplierIds = [...new Set(items.map((it) => it.preferredSupplierId).filter(Boolean).map((v) => parseInt(v, 10)))];
    let supplierNameById = new Map();
    if (supplierIds.length > 0) {
      const placeholders = supplierIds.map((_, i) => `@s${i}`).join(',');
      const supReq = pool.request();
      supplierIds.forEach((id, i) => supReq.input(`s${i}`, sql.Int, id));
      const supResult = await supReq.query(`SELECT SupplierId, SupplierName FROM dbo.Suppliers WHERE SupplierId IN (${placeholders})`);
      supplierNameById = new Map(supResult.recordset.map((r) => [r.SupplierId, r.SupplierName]));
    }

    // Fallback lookup only for whatever the exact-MatCenter stock category
    // above didn't cover.
    const namesNeedingFallback = items
      .map((it) => String(it.itemName).trim())
      .filter((name) => !categoryFromStockByLowerName.has(name.toLowerCase()));
    const fallbackCategoryByItemName = await resolveCategoryForItemNames(namesNeedingFallback);

    // Some items are only known to Busy's stock view by a bare product
    // code (e.g. "ING-0141") rather than a readable name — the dropdown
    // above still validated against that raw code unchanged. Resolve it
    // here to the real name via the Admin-managed vlookup table, so
    // Central Stores/Procurement/the supplier see the real name from this
    // point on while the raw code is preserved on the item for traceability.
    const itemCodeLookup = await resolveItemCodeLookup(items.map((it) => it.itemName));

    // Central Stores raising for themselves (2026-09-21) has nobody left
    // to review it — they ARE Central Stores — so it skips
    // 'PendingCentralStoresApproval' entirely and goes straight to
    // whatever a Central-Stores-approved requisition would land on: the
    // Ops Manager gate for a factory MatCenter (never true here, since
    // matCenter is always the fixed CENTRAL_STORES_MAT_CENTER constant,
    // but checked the same way central-stores.routes.js does for
    // consistency/future-proofing) or straight to 'Pending' otherwise —
    // i.e. immediately visible to Procurement.
    //
    // Transport fuel orders (2026-10-19) skip both reviews the same way.
    const initialStatus = isFuelOrder
      ? 'Pending'
      : req.user.role === 'StoreReceiving'
        ? (matCenterRequiresOpsApproval(matCenter) ? 'PendingOpsApproval' : 'Pending')
        : 'PendingCentralStoresApproval';

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const reqNo = await generateRequisitionNo(transaction);

      const reqResult = await new sql.Request(transaction)
        .input('BusyOrdNo',  sql.VarChar(25), reqNo)
        .input('BusyDate',   sql.DateTime,    new Date())
        .input('Warehouse',  sql.NVarChar(40), orderMatCenter)
        .input('MatCenter',  sql.NVarChar(40), orderMatCenter)
        .input('Status',     sql.VarChar(30), initialStatus)
        .input('Source',     sql.VarChar(20), 'Manual')
        .input('CreatedBy',  sql.Int,         req.user.userId)
        .input('OrderType',  sql.VarChar(20), isFuelOrder ? 'Fuel' : null)
        .input('Vehicle',    sql.NVarChar(40), vehicle ? vehicle.name : null)
        .query(`
          INSERT INTO dbo.Requisitions (BusyOrdNo, BusyDate, Warehouse, MatCenter, Status, Source, CreatedByUserId, OrderType, Vehicle)
          OUTPUT INSERTED.RequisitionId
          VALUES (@BusyOrdNo, @BusyDate, @Warehouse, @MatCenter, @Status, @Source, @CreatedBy, @OrderType, @Vehicle)
        `);
      const requisitionId = reqResult.recordset[0].RequisitionId;

      for (const it of items) {
        const rawItemName = String(it.itemName).trim();
        const codeHit = itemCodeLookup.get(rawItemName.toLowerCase());
        // Only the RAW code is used to look up category/stock (matches
        // what's actually in Itemwise_Stock); once resolved, the friendly
        // name is what gets stored and shown everywhere downstream.
        const itemName = codeHit ? codeHit.itemName : rawItemName;
        const itemCode = codeHit ? rawItemName : null;
        const category = categoryFromStockByLowerName.get(rawItemName.toLowerCase())
          || (codeHit && codeHit.category)
          || fallbackCategoryByItemName.get(rawItemName)
          || null;
        const preferredSupplierId = it.preferredSupplierId ? parseInt(it.preferredSupplierId, 10) : null;
        const preferredSupplierName = preferredSupplierId
          ? (supplierNameById.get(preferredSupplierId) || null)
          : (it.preferredSupplierName ? String(it.preferredSupplierName).trim() : null);

        await new sql.Request(transaction)
          .input('RequisitionId', sql.Int, requisitionId)
          .input('ItemName', sql.NVarChar(200), itemName)
          .input('ItemCode', sql.NVarChar(50), itemCode)
          .input('Qty', sql.Float, parseFloat(it.qty))
          .input('Unit', sql.NVarChar(20), it.unit)
          .input('Category', sql.NVarChar(100), category)
          .input('PreferredSupplierId', sql.Int, preferredSupplierId)
          .input('PreferredSupplierName', sql.NVarChar(200), preferredSupplierName)
          .input('PreferredBrand', sql.NVarChar(150), it.preferredBrand ? String(it.preferredBrand).trim() : null)
          .input('PreferredQuality', sql.NVarChar(500), it.preferredQuality ? String(it.preferredQuality).trim() : null)
          .input('UnitPrice', sql.Decimal(14, 4), isFuelOrder ? parseFloat(it.unitPrice) : null)
          .query(`
            INSERT INTO dbo.RequisitionItems
              (RequisitionId, ItemName, ItemCode, Qty, Unit, Category, PreferredSupplierId, PreferredSupplierName, PreferredBrand, PreferredQuality, UnitPrice)
            VALUES
              (@RequisitionId, @ItemName, @ItemCode, @Qty, @Unit, @Category, @PreferredSupplierId, @PreferredSupplierName, @PreferredBrand, @PreferredQuality, @UnitPrice)
          `);
      }

      await transaction.commit();
      res.status(201).json({ requisitionId, busyOrdNo: reqNo, status: initialStatus, orderType: isFuelOrder ? 'Fuel' : null });
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
