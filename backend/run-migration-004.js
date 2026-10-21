const { getPool, sql } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  const pool = await getPool();
  const migrationFile = path.join(__dirname, 'src', 'db', 'migrations', '004_add_destination_routing.sql');
  const script = fs.readFileSync(migrationFile, 'utf8');

  const batches = script.split(/^\s*GO\s*$/im).filter(b => b.trim());
  for (const batch of batches) {
    console.log('Executing batch...');
    await pool.request().query(batch);
  }
  console.log('Migration 004 completed successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
