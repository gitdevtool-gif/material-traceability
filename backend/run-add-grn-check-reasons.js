// One-off runner for add-grn-check-reasons.sql (root of repo).
// Adds GrnCheckReasons and the 'GrnReviewer' role (services/grn-approval.service.js).
const { getPool, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'add-grn-check-reasons.sql'), 'utf8');
    const cleaned = migrationSql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    for (const batch of cleaned.split(/^\s*GO\s*$/im)) {
      const trimmed = batch.trim();
      if (trimmed) await pool.request().query(trimmed);
    }
    console.log('add-grn-check-reasons.sql applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
run();
