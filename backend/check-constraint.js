require('dotenv').config();
const sql = require('mssql');
const c = {
  server: process.env.DB_SERVER, port: parseInt(process.env.DB_PORT, 10) || 1433, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};
(async () => {
  const p = await sql.connect(c);

  // 1. Check Status constraint
  const r = await p.request().query(`
    SELECT dc.name, dc.definition
    FROM sys.check_constraints dc
    JOIN sys.columns col ON dc.parent_object_id = col.object_id AND dc.parent_column_id = col.column_id
    WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND col.name = 'Status'
  `);
  console.log('Status constraints:', JSON.stringify(r.recordset, null, 2));

  // 2. Check all columns on DeliveryEntries
  const cols = await p.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'DeliveryEntries'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('\nDeliveryEntries columns:');
  cols.recordset.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}, nullable=${c.IS_NULLABLE})`));

  // 3. Try a test insert to see the real error
  try {
    const tx = new sql.Transaction(p);
    await tx.begin();
    const req = new sql.Request(tx);
    await req
      .input('entryNo', sql.VarChar(20), 'TEST-DEBUG-0001')
      .input('supplierId', sql.Int, 1)
      .input('consignmentNo', sql.VarChar(50), 'TEST-CONS')
      .input('deliveryDate', sql.Date, new Date())
      .input('deliveryTime', sql.Time, '08:00')
      .input('vehicleRegNo', sql.VarChar(20), 'KAA 000A')
      .input('firstWeight', sql.Decimal(10,2), 1000)
      .input('secondWeight', sql.Decimal(10,2), 500)
      .input('netWeight', sql.Decimal(10,2), 500)
      .input('notes', sql.NVarChar(500), null)
      .input('createdBy', sql.Int, 1)
      .query(`INSERT INTO dbo.DeliveryEntries
        (EntryNo, SupplierId, ConsignmentNo, DeliveryDate, DeliveryTime,
         VehicleRegNo, FirstWeight, SecondWeight, NetWeight, Notes, Status, CreatedBy)
        OUTPUT INSERTED.EntryId, INSERTED.EntryNo
        VALUES (@entryNo, @supplierId, @consignmentNo, @deliveryDate, @deliveryTime,
                @vehicleRegNo, @firstWeight, @secondWeight, @netWeight, @notes, 'GateReceived', @createdBy)`);
    console.log('\nTest INSERT succeeded');
    await tx.rollback(); // Don't keep the test record
  } catch (e) {
    console.error('\nTest INSERT failed:', e.message);
  }

  await p.close();
})();
