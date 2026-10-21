// One-off runner for add-lpo-reconciliation-supplier.sql (root of repo).
// Needed because evaluation.routes.js's /awarded split-award query joins
// on dbo.LPOReconciliation.SupplierId, which doesn't exist until this
// migration runs — until then that endpoint 500s with "Invalid column
// name 'SupplierId'" any time a split-awarded RFQ exists.
const { getPool, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'add-lpo-reconciliation-supplier.sql'), 'utf8'
    );
    // Strip full-line comments first so a leading comment block doesn't
    // cause the whole batch to be mistaken for a comment-only batch.
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
    console.log('add-lpo-reconciliation-supplier.sql applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
run();
