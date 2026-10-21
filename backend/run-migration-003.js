const { getPool, sql } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  const pool = await getPool();
  const migrationFile = path.join(__dirname, 'src', 'db', 'migrations', '003_move_weights_to_weighbridge.sql');
  const script = fs.readFileSync(migrationFile, 'utf8');
  
  // Split on GO and execute each batch
  const batches = script.split(/^\s*GO\s*$/im).filter(b => b.trim());
  for (const batch of batches) {
    console.log('Executing batch...');
    await pool.request().query(batch);
  }
  console.log('Migration 003 completed successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
