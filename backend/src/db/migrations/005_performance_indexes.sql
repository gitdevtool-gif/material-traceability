-- ============================================================
-- Migration 005: Performance indexes
-- ============================================================

-- Materials lookup by name (used in gate entry ERP product resolution)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Materials_MaterialName' AND object_id = OBJECT_ID('dbo.Materials'))
    CREATE INDEX IX_Materials_MaterialName ON dbo.Materials(MaterialName);
GO

-- DeliveryEntries.CreatedBy (used in JOINs on every list/detail query)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryEntries_CreatedBy' AND object_id = OBJECT_ID('dbo.DeliveryEntries'))
    CREATE INDEX IX_DeliveryEntries_CreatedBy ON dbo.DeliveryEntries(CreatedBy);
GO

-- DeliveryEntries.VehicleRegNo (searched with LIKE in entry list)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryEntries_VehicleRegNo' AND object_id = OBJECT_ID('dbo.DeliveryEntries'))
    CREATE INDEX IX_DeliveryEntries_VehicleRegNo ON dbo.DeliveryEntries(VehicleRegNo);
GO

-- AuditLogs composite index for common query patterns
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuditLogs_EntityType_Timestamp' AND object_id = OBJECT_ID('dbo.AuditLogs'))
    CREATE INDEX IX_AuditLogs_EntityType_Timestamp ON dbo.AuditLogs(EntityType, Timestamp DESC)
    INCLUDE (EntityId, Action, UserId);
GO

-- GoodsReceiptNotes.ReceivedAt (for date range filtering without CAST)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GRN_ReceivedAt' AND object_id = OBJECT_ID('dbo.GoodsReceiptNotes'))
    CREATE INDEX IX_GRN_ReceivedAt ON dbo.GoodsReceiptNotes(ReceivedAt DESC);
GO

-- StatusHistory composite (used in traceability report)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StatusHistory_Entity' AND object_id = OBJECT_ID('dbo.StatusHistory'))
    CREATE INDEX IX_StatusHistory_Entity ON dbo.StatusHistory(EntityType, EntityId, ChangedAt);
GO

-- QAInspections.EntryId (used in traceability joins)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_QAInspections_EntryId' AND object_id = OBJECT_ID('dbo.QAInspections'))
    CREATE INDEX IX_QAInspections_EntryId ON dbo.QAInspections(EntryId);
GO

-- GoodsRejectionNotes.EntryId (used in traceability joins)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GoodsRejectionNotes_EntryId' AND object_id = OBJECT_ID('dbo.GoodsRejectionNotes'))
    CREATE INDEX IX_GoodsRejectionNotes_EntryId ON dbo.GoodsRejectionNotes(EntryId);
GO

-- Record migration
INSERT INTO dbo.Migrations (MigrationName) VALUES ('005_performance_indexes');
GO

PRINT 'Migration 005: Performance indexes applied.';
GO
