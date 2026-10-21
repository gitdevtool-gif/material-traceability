// One-off runner for add-manual-requisition-creation.sql (root of repo).
// Adds schema for in-system purchase indent creation: Users.AssignedMatCenter,
// Requisitions' Central-Stores columns + new statuses, RequisitionItems'
// preferred-supplier/brand/quality columns, and dbo.CentralStoresItemDecisions.
const { getPool, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'add-manual-requisition-creation.sql'), 'utf8'
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
    console.log('add-manual-requisition-creation.sql applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
run();
