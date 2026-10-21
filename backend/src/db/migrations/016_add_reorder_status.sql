-- ============================================================
-- Migration 016: Add ReorderStatus table
-- Stores per-item per-factory reorder detection state, synced
-- from Busy ERP's dbo.reorder view.
--
-- Unique constraint on (ItemName, Factory) — the MERGE in
-- reorder-sync.service.js relies on this for idempotency.
--
-- Acknowledged* fields survive re-syncs: the MERGE UPDATE clause
-- deliberately excludes these columns.
-- ============================================================

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ReorderStatus')
CREATE TABLE dbo.ReorderStatus (
  ReorderStatusId       INT             PRIMARY KEY IDENTITY(1,1),

  -- Identity — must match Busy ERP dbo.reorder (Name, factory)
  ItemName              NVARCHAR(200)   NOT NULL,
  Factory               NVARCHAR(80)    NOT NULL,
  ItemGroup             NVARCHAR(80)    NULL,

  -- Live figures (overwritten on every sync, never manually edited)
  LiveStock             FLOAT           NOT NULL  DEFAULT 0,
  ReorderLevel          FLOAT           NOT NULL  DEFAULT 0,
  MaxStockLevel         FLOAT           NULL,

  -- Computed on sync:
  --   NeedsReorder = LiveStock <= ReorderLevel  (negative LiveStock valid)
  --   RequiredQty  = MAX(0, MaxStockLevel - LiveStock)
  NeedsReorder          BIT             NOT NULL  DEFAULT 0,
  RequiredQty           FLOAT           NOT NULL  DEFAULT 0,

  LeadTime              DECIMAL(5,2)    NULL,
  SyncedAt              DATETIME2       NULL,

  -- Acknowledgement — set by a user, survived through re-syncs
  AcknowledgedByUserId  INT             NULL
    REFERENCES dbo.Users(UserId),
  AcknowledgedAt        DATETIME2       NULL,
  AcknowledgedNotes     NVARCHAR(500)   NULL,

  CONSTRAINT UQ_ReorderStatus_Item UNIQUE (ItemName, Factory)
);
GO

-- Index to speed up the most common query pattern
-- (NeedsReorder=1 first, then gap size)
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.ReorderStatus')
    AND name = 'IX_ReorderStatus_NeedsReorder'
)
  CREATE INDEX IX_ReorderStatus_NeedsReorder
    ON dbo.ReorderStatus (NeedsReorder DESC, Factory, ItemGroup);
GO
