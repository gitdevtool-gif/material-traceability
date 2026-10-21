const { getPool, sql, closePool } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const pool = await getPool();
    const migrationSql = fs.readFileSync(
      path.join(__dirname, 'src/db/migrations/008_add_ops_manager_approval.sql'), 'utf8'
    );
    const batches = migrationSql.split(/\nGO\b/i);
    for (const batch of batches) {
      const trimmed = batch.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        await pool.request().query(trimmed);
      }
    }
    console.log('Migration 008 applied successfully');
    // Record in Migrations table
    await pool.request()
      .input('name', sql.VarChar(200), '008_add_ops_manager_approval')
      .input('appliedAt', sql.DateTime2, new Date())
      .query("IF NOT EXISTS (SELECT 1 FROM dbo.Migrations WHERE Name = @name) INSERT INTO dbo.Migrations (Name, AppliedAt) VALUES (@name, @appliedAt)");
    console.log('Migration recorded');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await closePool();
  }
}
run();
