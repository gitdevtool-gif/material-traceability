require('dotenv').config();
const sql = require('mssql');
const config = { server: process.env.ERP_DB_SERVER, port: parseInt(process.env.ERP_DB_PORT, 10) || 1433, database: process.env.ERP_DB_NAME, user: process.env.ERP_DB_USER, password: process.env.ERP_DB_PASSWORD, options: { encrypt: false, trustServerCertificate: true } };
sql.connect(config).then(async pool => {
  const r = await pool.request().query(`SELECT TOP 8 RTRIM(VchNo) AS VchNo, Name, [Mat Center], Qty, [Date] FROM dbo.GoodsReceived ORDER BY [Date] DESC`);
  console.log(JSON.stringify(r.recordset, null, 2));
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
