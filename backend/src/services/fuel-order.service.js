/**
 * Transport fuel orders (2026-10-19)
 *
 * Transport raises fuel per vehicle. In Busy (verified 2026-10-19):
 *   vehicles   Master1 MasterType 4 (Cost Centre) in the "Transport" group,
 *              named by registration ("KDL 783Y"); 38 of the 42 also exist
 *              as a Material Centre (MasterType 11) of the same name
 *   fuel POs   item "Motor Vehicle fuel-diesel" / "Motor Vehicle fuel-petrol"
 *              (service items, unit "Units"), store = the vehicle, the
 *              vehicle named in the narration, tax type VAT/TaxIncl. at 8%
 *              (e.g. Pur-2745---2026-27, settled by purchase 2455)
 *   cost centre is only allocated on the purchase bill, never on the PO
 *
 * A fuel order skips Central Stores / Ops review (straight to 'Pending') and
 * Procurement raises the Busy PO from the requisition — no RFQ. Litres are
 * often unknown (0) but the requester gives the unit price.
 */
const { getErpPool } = require('../erpDb');

const TRANSPORT_MAT_CENTER = 'Transport';
const VEHICLE_GROUP = 'Transport';
// Busy item name -> label shown to the requester.
const FUEL_ITEMS = {
  'Motor Vehicle fuel-diesel': 'Diesel',
  'Motor Vehicle fuel-petrol': 'Petrol',
};
const FUEL_VAT_RATE = 8;
const FUEL_TAX_TYPE = 'VAT/TaxIncl.';

const isTransport = (matCenter) => String(matCenter || '').trim().toUpperCase() === TRANSPORT_MAT_CENTER.toUpperCase();

/** Busy item name for a fuel item (case-insensitive), or null if it isn't one. */
function fuelItemName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  return Object.keys(FUEL_ITEMS).find((k) => k.toLowerCase() === wanted) || null;
}

/**
 * Vehicles = Transport cost centres starting with K, with the Busy store to
 * post them to: the Material Centre of the same name, else the Transport store.
 */
async function listVehicles() {
  const erpPool = await getErpPool();
  const result = await erpPool.request()
    .input('grp', VEHICLE_GROUP)
    .query(`
      SELECT LTRIM(RTRIM(c.Name)) AS Name, LTRIM(RTRIM(mc.Name)) AS Store
      FROM dbo.Master1 c
      JOIN dbo.Master1 g ON g.Code = c.ParentGrp AND LTRIM(RTRIM(g.Name)) = @grp
      LEFT JOIN dbo.Master1 mc ON mc.MasterType = 11 AND LTRIM(RTRIM(mc.Name)) = LTRIM(RTRIM(c.Name))
      WHERE c.MasterType = 4 AND c.Name LIKE 'K%'
      ORDER BY c.Name
    `);
  return result.recordset.map((r) => ({
    name: r.Name,
    store: r.Store || TRANSPORT_MAT_CENTER,
    isStore: !!r.Store,
  }));
}

/** The vehicle (exact Busy spelling + store) for a name, or null. */
async function resolveVehicle(name) {
  const wanted = String(name || '').trim().toUpperCase();
  if (!wanted) return null;
  return (await listVehicles()).find((v) => v.name.toUpperCase() === wanted) || null;
}

module.exports = {
  TRANSPORT_MAT_CENTER, FUEL_ITEMS, FUEL_VAT_RATE, FUEL_TAX_TYPE,
  isTransport, fuelItemName, listVehicles, resolveVehicle,
};
