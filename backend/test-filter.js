const { getPool, sql } = require('./src/db');

(async () => {
  try {
    const p = await getPool();

    // Test with factory filter "F1"
    const r = p.request();
    r.input('factory', sql.NVarChar(100), 'F1');
    const stats = await r.query(`
      SELECT COUNT(*) AS TotalInspections
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
      WHERE 1=1 AND ISNULL(sl.LocationName, '') = @factory
    `);
    console.log('F1 filter:', JSON.stringify(stats.recordset[0]));

    // Test with factory filter "F7-STORE"
    const r2 = p.request();
    r2.input('factory', sql.NVarChar(100), 'F7-STORE');
    const stats2 = await r2.query(`
      SELECT COUNT(*) AS TotalInspections
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
      WHERE 1=1 AND ISNULL(sl.LocationName, '') = @factory
    `);
    console.log('F7-STORE filter:', JSON.stringify(stats2.recordset[0]));

    // Show all with their factory
    const r3 = await p.request().query(`
      SELECT qi.InspectionNo, sl.LocationName AS Factory
      FROM dbo.QAInspections qi
      JOIN dbo.DeliveryEntries de ON de.EntryId = qi.EntryId
      LEFT JOIN dbo.GoodsReceiptNotes g ON g.EntryId = de.EntryId
      LEFT JOIN dbo.StockLocations sl ON sl.LocationId = g.LocationId
    `);
    console.log('All with factory:', JSON.stringify(r3.recordset));

    process.exit(0);
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  }
})();
