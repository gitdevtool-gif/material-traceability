/**
 * System Settings (2026-10-27) — values Admin changes from the System
 * Settings page instead of a code change, stored as JSON in dbo.AppSettings
 * (add-app-settings.sql). Each setting is declared in SETTINGS with its
 * default and validator; an unknown key is never read or written.
 */
const { getPool, sql } = require('../db');

const UNIT_MAX_LEN = 20; // RequisitionItems.Unit is NVARCHAR(20)

function cleanUnits(value) {
  if (!Array.isArray(value)) throw new Error('Units must be a list');
  const seen = new Set();
  const units = [];
  for (const raw of value) {
    const u = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!u) continue;
    if (u.length > UNIT_MAX_LEN) throw new Error(`"${u}" is too long (${UNIT_MAX_LEN} characters at most)`);
    if (seen.has(u.toLowerCase())) continue;
    seen.add(u.toLowerCase());
    units.push(u);
  }
  if (units.length === 0) throw new Error('Keep at least one unit');
  // Fuel orders are always in litres.
  if (!seen.has('litres')) throw new Error('Litres cannot be removed — fuel orders use it');
  return units;
}

// Busy item names (Master1.Name, nvarchar(40)) bought from standing
// suppliers at their standing price — no RFQ (2026-11-24, direct-supply.service.js).
function cleanItemNames(value) {
  if (!Array.isArray(value)) throw new Error('Items must be a list');
  const seen = new Set();
  const items = [];
  for (const raw of value) {
    const n = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!n) continue;
    if (n.length > 40) throw new Error(`"${n}" is longer than a Busy item name (40 characters)`);
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    items.push(n);
  }
  return items;
}

const SETTINGS = {
  'requisition.units': {
    label: 'Raise Order — units of measure',
    default: ['Kgs', 'Pcs', 'Metres', 'Litres', 'Set', 'Rim', 'Rolls'],
    clean: cleanUnits,
  },
  'directSupply.items': {
    label: 'Direct-supply items (standing suppliers, no RFQ)',
    // Offcuts are bought exactly like sawdust (standing F8 suppliers, e.g.
    // Mijengo 2400 + VAT 16%) and sit on the same requisitions. Firewood is
    // not: it has no Busy POs this year, so it stays on the RFQ path.
    default: ['SAW DUST IN TONNES', 'OFFCUTS IN TONNES'],
    clean: cleanItemNames,
  },
};

const CACHE_MS = 60 * 1000;
const cache = new Map(); // key -> { value, at }

async function getSetting(key) {
  const def = SETTINGS[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value = def.default;
  try {
    const pool = await getPool();
    const row = (await pool.request().input('key', sql.VarChar(100), key)
      .query('SELECT SettingValue FROM dbo.AppSettings WHERE SettingKey = @key')).recordset[0];
    if (row) value = def.clean(JSON.parse(row.SettingValue));
  } catch {
    // Table not created yet, or a bad stored value: fall back to the default.
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function setSetting(key, value, userId) {
  const def = SETTINGS[key];
  if (!def) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 404 });
  let clean;
  try { clean = def.clean(value); } catch (e) { throw Object.assign(e, { status: 400 }); }
  const old = await getSetting(key);
  const pool = await getPool();
  await pool.request()
    .input('key', sql.VarChar(100), key)
    .input('value', sql.NVarChar(sql.MAX), JSON.stringify(clean))
    .input('userId', sql.Int, userId || null)
    .query(`MERGE dbo.AppSettings AS t
            USING (SELECT @key AS SettingKey) AS s ON t.SettingKey = s.SettingKey
            WHEN MATCHED THEN UPDATE SET SettingValue = @value, UpdatedBy = @userId, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue, UpdatedBy) VALUES (@key, @value, @userId);`);
  cache.set(key, { value: clean, at: Date.now() });
  return { old, value: clean };
}

async function listSettings() {
  const pool = await getPool();
  let meta = new Map();
  try {
    meta = new Map((await pool.request().query(`
      SELECT s.SettingKey, s.UpdatedAt, u.FullName AS UpdatedByName
      FROM dbo.AppSettings s LEFT JOIN dbo.Users u ON u.UserId = s.UpdatedBy`)).recordset.map((r) => [r.SettingKey, r]));
  } catch { /* table not created yet */ }
  const out = [];
  for (const [key, def] of Object.entries(SETTINGS)) {
    cache.delete(key);
    const m = meta.get(key);
    out.push({ key, label: def.label, value: await getSetting(key), default: def.default,
               updatedAt: m?.UpdatedAt || null, updatedBy: m?.UpdatedByName || null });
  }
  return out;
}

const getRequisitionUnits = () => getSetting('requisition.units');
const getDirectSupplyItems = () => getSetting('directSupply.items');

module.exports = { getSetting, setSetting, listSettings, getRequisitionUnits, getDirectSupplyItems, SETTINGS };
