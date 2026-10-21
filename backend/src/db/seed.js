/**
 * Seed script — creates default admin user, sample suppliers, materials, and locations.
 * Run once after migration: npm run seed
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, sql, closePool } = require('../db');
const logger = require('../logger');

// No password is stored in the source. Set SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD
// to choose them; otherwise a random one is generated and logged once.
const generated = () => crypto.randomBytes(9).toString('base64url');

async function seed() {
  const pool = await getPool();

  // ── Admin user ──
  const adminExists = await pool.request()
    .input('u', sql.VarChar(50), 'admin')
    .query('SELECT 1 FROM dbo.Users WHERE Username = @u');

  if (adminExists.recordset.length === 0) {
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || generated();
    const hash = await bcrypt.hash(adminPassword, 12);
    await pool.request()
      .input('username', sql.VarChar(50), 'admin')
      .input('hash', sql.VarChar(255), hash)
      .input('fullName', sql.NVarChar(150), 'Gilbert')
      .input('email', sql.VarChar(100), 'gilbert@njorocanning.co.ke')
      .input('role', sql.VarChar(30), 'Admin')
      .input('dept', sql.VarChar(100), 'IT')
      .query(`INSERT INTO dbo.Users (Username,PasswordHash,FullName,Email,Role,Department)
              VALUES (@username,@hash,@fullName,@email,@role,@dept)`);
    logger.info(process.env.SEED_ADMIN_PASSWORD
      ? 'Admin user created (admin / password from SEED_ADMIN_PASSWORD)'
      : `Admin user created (admin / ${adminPassword}) — change it after first login`);
  }

  // ── Demo users per role ──
  const demoUsers = [
    { username: 'gate1', fullName: 'Gate Security Officer', email: 'gate1@njorocanning.co.ke', role: 'GateSecurity', dept: 'Security' },
    { username: 'wb1', fullName: 'Weighbridge Operator', email: 'wb1@njorocanning.co.ke', role: 'Weighbridge', dept: 'Logistics' },
    { username: 'store1', fullName: 'Stores Receiver', email: 'store1@njorocanning.co.ke', role: 'StoreReceiving', dept: 'Central Stores' },
    { username: 'factory1', fullName: 'Factory Receiver', email: 'factory1@njorocanning.co.ke', role: 'FactoryReceiving', dept: 'Production' },
    { username: 'super1', fullName: 'Receiving Supervisor', email: 'super1@njorocanning.co.ke', role: 'Supervisor', dept: 'Operations' },
    { username: 'audit1', fullName: 'Auditor', email: 'audit1@njorocanning.co.ke', role: 'Auditor', dept: 'Finance' },
    { username: 'qa1', fullName: 'QA Inspector', email: 'qa1@njorocanning.co.ke', role: 'QAInspector', dept: 'Quality Assurance' },
    { username: 'qamgr1', fullName: 'QA Manager', email: 'qamgr1@njorocanning.co.ke', role: 'QAManager', dept: 'Quality Assurance' },
    { username: 'prodclerk1', fullName: 'Production Clerk', email: 'prodclerk1@njorocanning.co.ke', role: 'ProductionClerk', dept: 'Production' },
  ];

  for (const u of demoUsers) {
    const exists = await pool.request()
      .input('u', sql.VarChar(50), u.username)
      .query('SELECT 1 FROM dbo.Users WHERE Username = @u');
    if (exists.recordset.length === 0) {
      const demoPassword = process.env.SEED_DEMO_PASSWORD || generated();
      const hash = await bcrypt.hash(demoPassword, 12);
      await pool.request()
        .input('username', sql.VarChar(50), u.username)
        .input('hash', sql.VarChar(255), hash)
        .input('fullName', sql.NVarChar(150), u.fullName)
        .input('email', sql.VarChar(100), u.email)
        .input('role', sql.VarChar(30), u.role)
        .input('dept', sql.VarChar(100), u.dept)
        .query(`INSERT INTO dbo.Users (Username,PasswordHash,FullName,Email,Role,Department)
                VALUES (@username,@hash,@fullName,@email,@role,@dept)`);
      logger.info(`User created: ${u.username} (${u.role})${process.env.SEED_DEMO_PASSWORD ? '' : ` password: ${demoPassword}`}`);
    }
  }

  // ── Suppliers ──
  const suppliers = [
    { code: 'SUP-001', name: 'Acme Raw Materials Ltd' },
    { code: 'SUP-002', name: 'Global Ingredients Co.' },
    { code: 'SUP-003', name: 'PackRight Packaging' },
    { code: 'SUP-004', name: 'ChemSource Industries' },
  ];

  for (const s of suppliers) {
    const exists = await pool.request()
      .input('c', sql.VarChar(20), s.code)
      .query('SELECT 1 FROM dbo.Suppliers WHERE SupplierCode = @c');
    if (exists.recordset.length === 0) {
      await pool.request()
        .input('code', sql.VarChar(20), s.code)
        .input('name', sql.NVarChar(200), s.name)
        .query(`INSERT INTO dbo.Suppliers (SupplierCode,SupplierName) VALUES (@code,@name)`);
      logger.info(`Supplier created: ${s.code}`);
    }
  }

  // ── Materials ──
  const materials = [
    { code: 'RM-001', name: 'Wheat Flour', category: 'RawMaterial', uom: 'kg' },
    { code: 'RM-002', name: 'Sugar', category: 'RawMaterial', uom: 'kg' },
    { code: 'ING-001', name: 'Yeast', category: 'Ingredient', uom: 'kg' },
    { code: 'ING-002', name: 'Salt', category: 'Ingredient', uom: 'kg' },
    { code: 'PKG-001', name: 'Polyethylene Bags', category: 'Packaging', uom: 'units' },
    { code: 'CHM-001', name: 'Citric Acid', category: 'Chemical', uom: 'litres' },
  ];

  for (const m of materials) {
    const exists = await pool.request()
      .input('c', sql.VarChar(30), m.code)
      .query('SELECT 1 FROM dbo.Materials WHERE MaterialCode = @c');
    if (exists.recordset.length === 0) {
      await pool.request()
        .input('code', sql.VarChar(30), m.code)
        .input('name', sql.NVarChar(200), m.name)
        .input('cat', sql.VarChar(50), m.category)
        .input('uom', sql.VarChar(20), m.uom)
        .query(`INSERT INTO dbo.Materials (MaterialCode,MaterialName,Category,UOM)
                VALUES (@code,@name,@cat,@uom)`);
      logger.info(`Material created: ${m.code}`);
    }
  }

  // ── Stock Locations ──
  const locations = [
    { name: 'CENTRAL STORES', type: 'CentralStore' },
    { name: 'F7-STORE', type: 'Factory' },
  ];

  for (const l of locations) {
    const exists = await pool.request()
      .input('n', sql.NVarChar(100), l.name)
      .query('SELECT 1 FROM dbo.StockLocations WHERE LocationName = @n');
    if (exists.recordset.length === 0) {
      await pool.request()
        .input('name', sql.NVarChar(100), l.name)
        .input('type', sql.VarChar(20), l.type)
        .query(`INSERT INTO dbo.StockLocations (LocationName,LocationType) VALUES (@name,@type)`);
      logger.info(`Location created: ${l.name}`);
    }
  }

  logger.info('Seed complete.');
  await closePool();
}

seed().catch(err => {
  logger.error('Seed failed', err);
  process.exit(1);
});
