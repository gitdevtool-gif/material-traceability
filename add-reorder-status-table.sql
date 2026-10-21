-- ============================================================
-- add-reorder-status-table.sql
-- Run once against the local MaterialTraceability database.
-- Equivalent to migration 016_add_reorder_status.sql but
-- provided as a standalone script for SSMS / one-off execution.
--
-- Safe to run multiple times — uses IF NOT EXISTS guards.
-- ============================================================

USE [MaterialTraceability];
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ReorderStatus')
CREATE TABLE dbo.ReorderStatus (
  ReorderStatusId       INT             PRIMARY KEY IDENTITY(1,1),

  -- Identity — matches Busy ERP dbo.reorder (Name, factory)
  ItemName              NVARCHAR(200)   NOT NULL,
  Factory               NVARCHAR(80)    NOT NULL,
  ItemGroup             NVARCHAR(80)    NULL,

  -- Live figures, overwritten on every sync
  LiveStock             FLOAT           NOT NULL  DEFAULT 0,
  ReorderLevel          FLOAT           NOT NULL  DEFAULT 0,
  MaxStockLevel         FLOAT           NULL,

  -- Computed:
  --   NeedsReorder = LiveStock <= ReorderLevel  (negative stock is valid)
  --   RequiredQty  = MAX(0, MaxStockLevel - LiveStock)
  NeedsReorder          BIT             NOT NULL  DEFAULT 0,
  RequiredQty           FLOAT           NOT NULL  DEFAULT 0,

  LeadTime              DECIMAL(5,2)    NULL,
  SyncedAt              DATETIME2       NULL,

  -- Acknowledgement survives re-syncs (MERGE never overwrites these)
  AcknowledgedByUserId  INT             NULL
    REFERENCES dbo.Users(UserId),
  AcknowledgedAt        DATETIME2       NULL,
  AcknowledgedNotes     NVARCHAR(500)   NULL,

  CONSTRAINT UQ_ReorderStatus_Item UNIQUE (ItemName, Factory)
);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.ReorderStatus')
    AND name = 'IX_ReorderStatus_NeedsReorder'
)
  CREATE INDEX IX_ReorderStatus_NeedsReorder
    ON dbo.ReorderStatus (NeedsReorder DESC, Factory, ItemGroup);
GO

-- Verify
SELECT
  OBJECT_NAME(object_id) AS TableName,
  name AS ColumnName,
  TYPE_NAME(system_type_id) AS DataType,
  is_nullable
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.ReorderStatus')
ORDER BY column_id;
GO
