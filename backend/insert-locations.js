const { getPool, sql, closePool } = require('./src/db');

(async () => {
  const pool = await getPool();
  const locs = [
    { name: 'CENTRAL STORES', type: 'CentralStore' },
    { name: 'F7-STORE', type: 'Factory' },
  ];
  for (const l of locs) {
    const exists = await pool.request()
      .input('n', sql.NVarChar(100), l.name)
      .query('SELECT 1 FROM dbo.StockLocations WHERE LocationName = @n');
    if (exists.recordset.length === 0) {
      await pool.request()
        .input('name', sql.NVarChar(100), l.name)
        .input('type', sql.VarChar(20), l.type)
        .query('INSERT INTO dbo.StockLocations (LocationName, LocationType) VALUES (@name, @type)');
      console.log('Inserted:', l.name);
    } else {
      console.log('Already exists:', l.name);
    }
  }
  // Deactivate old locations
  await pool.request().query("UPDATE dbo.StockLocations SET IsActive = 0 WHERE LocationName NOT IN ('CENTRAL STORES','F7-STORE')");
  console.log('Old locations deactivated');
  await closePool();
})();
