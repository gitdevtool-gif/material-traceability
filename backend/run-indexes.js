const { getPool, sql, closePool } = require('./src/db');

(async () => {
  const pool = await getPool();

  const indexes = [
    { name: 'IX_Materials_MaterialName', table: 'dbo.Materials', sql: 'CREATE INDEX IX_Materials_MaterialName ON dbo.Materials(MaterialName)' },
    { name: 'IX_DeliveryEntries_CreatedBy', table: 'dbo.DeliveryEntries', sql: 'CREATE INDEX IX_DeliveryEntries_CreatedBy ON dbo.DeliveryEntries(CreatedBy)' },
    { name: 'IX_DeliveryEntries_VehicleRegNo', table: 'dbo.DeliveryEntries', sql: 'CREATE INDEX IX_DeliveryEntries_VehicleRegNo ON dbo.DeliveryEntries(VehicleRegNo)' },
    { name: 'IX_AuditLogs_EntityType_Timestamp', table: 'dbo.AuditLogs', sql: 'CREATE INDEX IX_AuditLogs_EntityType_Timestamp ON dbo.AuditLogs(EntityType, Timestamp DESC) INCLUDE (EntityId, Action, UserId)' },
    { name: 'IX_GRN_ReceivedAt', table: 'dbo.GoodsReceiptNotes', sql: 'CREATE INDEX IX_GRN_ReceivedAt ON dbo.GoodsReceiptNotes(ReceivedAt DESC)' },
    { name: 'IX_StatusHistory_Entity', table: 'dbo.StatusHistory', sql: 'CREATE INDEX IX_StatusHistory_Entity ON dbo.StatusHistory(EntityType, EntityId, ChangedAt)' },
    { name: 'IX_QAInspections_EntryId', table: 'dbo.QAInspections', sql: 'CREATE INDEX IX_QAInspections_EntryId ON dbo.QAInspections(EntryId)' },
    { name: 'IX_GoodsRejectionNotes_EntryId', table: 'dbo.GoodsRejectionNotes', sql: 'CREATE INDEX IX_GoodsRejectionNotes_EntryId ON dbo.GoodsRejectionNotes(EntryId)' },
  ];

  for (const idx of indexes) {
    try {
      const check = await pool.request()
        .input('idxName', sql.NVarChar(200), idx.name)
        .query("SELECT 1 FROM sys.indexes WHERE name = @idxName");
      if (check.recordset.length > 0) {
        console.log('EXISTS:', idx.name);
      } else {
        await pool.request().query(idx.sql);
        console.log('CREATED:', idx.name);
      }
    } catch (e) {
      console.log('ERROR:', idx.name, '-', e.message);
    }
  }

  console.log('Done — all indexes applied.');
  await closePool();
})();
