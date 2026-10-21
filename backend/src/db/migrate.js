const fs = require('fs');
const path = require('path');
const { getPool, sql, closePool } = require('../db');
const logger = require('../logger');

async function runMigrations() {
  const pool = await getPool();

  // Ensure migrations tracking table
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Migrations')
    CREATE TABLE dbo.Migrations (
      MigrationId   INT PRIMARY KEY IDENTITY(1,1),
      FileName      VARCHAR(200) NOT NULL UNIQUE,
      AppliedAt     DATETIME2 DEFAULT GETUTCDATE()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = await pool.request()
      .input('fileName', sql.VarChar(200), file)
      .query('SELECT 1 FROM dbo.Migrations WHERE FileName = @fileName');

    if (applied.recordset.length > 0) {
      logger.info(`Skipping already-applied migration: ${file}`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sqlText = fs.readFileSync(filePath, 'utf8');

    // Split on GO statements for MSSQL batch execution
    const batches = sqlText.split(/^\s*GO\s*$/im).filter(b => b.trim());

    logger.info(`Applying migration: ${file}`);
    for (const batch of batches) {
      await pool.request().query(batch);
    }

    // Re-ensure Migrations table exists (in case migration dropped it)
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Migrations')
      CREATE TABLE dbo.Migrations (
        MigrationId   INT PRIMARY KEY IDENTITY(1,1),
        FileName      VARCHAR(200) NOT NULL UNIQUE,
        AppliedAt     DATETIME2 DEFAULT GETUTCDATE()
      );
    `);

    await pool.request()
      .input('fileName', sql.VarChar(200), file)
      .query('INSERT INTO dbo.Migrations (FileName) VALUES (@fileName)');

    logger.info(`Migration applied: ${file}`);
  }

  logger.info('All migrations applied.');
  await closePool();
}

runMigrations().catch(err => {
  logger.error('Migration failed', err);
  process.exit(1);
});
