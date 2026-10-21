require('dotenv').config();
const sql = require('mssql');
const config = {
  server: process.env.DB_SERVER, port: parseInt(process.env.DB_PORT, 10) || 1433, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};
(async () => {
  const p = await sql.connect(config);
  console.log('Connected');
  try {
    const req = p.request();
    const r = await req
      .input('entryNo', sql.VarChar(20), 'TEST-DBG-0001')
      .input('supplierId', sql.Int, 1)
      .input('consignmentNo', sql.VarChar(50), 'TEST-CONS')
      .input('deliveryDate', sql.Date, new Date())
      .input('deliveryTime', sql.VarChar(8), '08:00')
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
    console.log('INSERT OK:', r.recordset[0]);
    // Clean up
    await p.request().input('eid', sql.Int, r.recordset[0].EntryId)
      .query('DELETE FROM dbo.DeliveryEntries WHERE EntryId = @eid');
    console.log('Cleaned up test row');
  } catch (e) {
    console.log('INSERT ERROR:', e.message);
    console.log('  number:', e.number);
    console.log('  state:', e.state);
  }
  await p.close();
  process.exit(0);
})();
