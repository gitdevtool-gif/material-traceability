const { getPool, sql } = require('./src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  const pool = await getPool();
  const migrationFile = path.join(__dirname, '..', 'add-quotation-alternate-prices.sql');
  const script = fs.readFileSync(migrationFile, 'utf8');

  const batches = script
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter(Boolean);

  for (const batch of batches) {
    await pool.request().query(batch);
  }
  console.log('add-quotation-alternate-prices.sql applied successfully');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
