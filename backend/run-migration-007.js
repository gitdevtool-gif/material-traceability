require('dotenv').config();
const sql = require('mssql');
const config = { server: process.env.DB_SERVER, port: parseInt(process.env.DB_PORT, 10) || 1433, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, options: { encrypt: false, trustServerCertificate: true } };
sql.connect(config).then(async pool => {
  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'VehicleInspectionDone'
    )
    ALTER TABLE dbo.QAInspections ADD VehicleInspectionDone BIT DEFAULT 0
  `);
  console.log('Column added successfully');
  process.exit(0);
}).catch(err => { console.error(err.message); process.exit(1); });
