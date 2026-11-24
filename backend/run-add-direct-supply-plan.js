// One-off runner for add-direct-supply-plan.sql (root of repo).
// Adds DirectSupplyPlan (services/direct-supply.service.js). Safe to re-run.
const { getPool, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'add-direct-supply-plan.sql'), 'utf8');
    const cleaned = migrationSql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    for (const batch of cleaned.split(/^\s*GO\s*$/im)) {
      const trimmed = batch.trim();
      if (trimmed) await pool.request().query(trimmed);
    }
    console.log('add-direct-supply-plan.sql applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
run();
