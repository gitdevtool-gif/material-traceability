// One-off runner for add-item-code-lookup.sql (root of repo).
// Adds dbo.ItemCodeLookup (code -> real item name/category vlookup table)
// and RequisitionItems.ItemCode.
const { getPool, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'add-item-code-lookup.sql'), 'utf8'
    );
    const cleaned = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const batches = cleaned.split(/^\s*GO\s*$/im);
    for (const batch of batches) {
      const trimmed = batch.trim();
      if (trimmed) {
        await pool.request().query(trimmed);
      }
    }
    console.log('add-item-code-lookup.sql applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
run();
