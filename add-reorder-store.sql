-- Reorder Levels per inventory store (2026-11-11): Central Stores and F7 are
-- separate inventories, each with its own items, stock, use and levels — one
-- row per store per item instead of one combined row per item. Existing rows
-- become Central Stores rows until the next sync rebuilds them.
IF COL_LENGTH('dbo.ReorderStatus', 'Store') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD Store NVARCHAR(80) NOT NULL CONSTRAINT DF_ReorderStatus_Store DEFAULT 'CENTRAL STORES';
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ReorderStatus_ItemName' AND object_id = OBJECT_ID('dbo.ReorderStatus'))
BEGIN
  IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_ReorderStatus_ItemName')
    ALTER TABLE dbo.ReorderStatus DROP CONSTRAINT UQ_ReorderStatus_ItemName;
  ELSE
    DROP INDEX UQ_ReorderStatus_ItemName ON dbo.ReorderStatus;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ReorderStatus_Store_Item' AND object_id = OBJECT_ID('dbo.ReorderStatus'))
  CREATE UNIQUE INDEX UQ_ReorderStatus_Store_Item ON dbo.ReorderStatus (Store, ItemName);
GO
