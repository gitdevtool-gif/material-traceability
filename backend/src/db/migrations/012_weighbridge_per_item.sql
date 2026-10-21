-- ============================================================
-- Migration 012: Per-item weighbridge records
-- Each DeliveryEntryItem gets its own ticket number and weights
-- instead of one record per delivery entry.
-- ============================================================

-- 1. Drop the 1:1 unique constraint so multiple rows per entry are allowed
IF EXISTS (
  SELECT 1 FROM sys.key_constraints
  WHERE name = 'UQ_WeighbridgeRecords_EntryId'
    AND parent_object_id = OBJECT_ID('dbo.WeighbridgeRecords')
)
  ALTER TABLE dbo.WeighbridgeRecords DROP CONSTRAINT UQ_WeighbridgeRecords_EntryId;
GO

-- 2. Add EntryItemId column (links each weighbridge row to a specific line item)
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.WeighbridgeRecords') AND name = 'EntryItemId'
)
  ALTER TABLE dbo.WeighbridgeRecords ADD EntryItemId BIGINT NULL;
GO

-- 3. Add foreign key to DeliveryEntryItems
IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'FK_WeighbridgeRecords_EntryItem'
    AND parent_object_id = OBJECT_ID('dbo.WeighbridgeRecords')
)
  ALTER TABLE dbo.WeighbridgeRecords
    ADD CONSTRAINT FK_WeighbridgeRecords_EntryItem
    FOREIGN KEY (EntryItemId) REFERENCES dbo.DeliveryEntryItems(EntryItemId);
GO

-- 4. Unique index: one weighbridge row per item (NULL allowed for legacy rows)
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_WeighbridgeRecords_EntryItemId'
    AND object_id = OBJECT_ID('dbo.WeighbridgeRecords')
)
  CREATE UNIQUE INDEX UQ_WeighbridgeRecords_EntryItemId
    ON dbo.WeighbridgeRecords(EntryItemId)
    WHERE EntryItemId IS NOT NULL;
GO

PRINT 'Migration 012 applied: per-item weighbridge records';
GO
