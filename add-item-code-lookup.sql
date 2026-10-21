-- ============================================================
-- Migration: Item Code → Name lookup (vlookup table)
--
-- Some items in Busy's dbo.Itemwise_Stock view are only identifiable by
-- a product code (e.g. "ING-0141") instead of a readable name — 47
-- distinct codes verified live, all currently under category
-- INGREDIENTS. The item-picker dropdown when raising a requisition
-- keeps showing/selecting by that code (unchanged), but everywhere the
-- request is seen afterwards — Central Stores, Procurement, and any
-- supplier-facing RFQ output — should show the real item name instead.
--
-- This table is Admin-managed (own DB, not synced from Busy — Busy has
-- no such mapping) and seeded here with only the handful of sample rows
-- the user gave as an example; the full list is pasted into the new
-- Admin "Item Code Lookup" page (bulk-import textarea) after this runs.
--
-- 1. New table ItemCodeLookup — ItemCode is unique (this DB's default
--    collation is case-insensitive, already confirmed for the similar
--    MatCenter/factory matching earlier in this project, so "ing-0028"
--    and "ING-0028" collide as the same code, matching how Busy itself
--    stores this inconsistently-cased).
--
-- 2. RequisitionItems.ItemCode — keeps the original code alongside the
--    resolved ItemName, purely for audit/traceability back to Busy.
--    NULL for items that were never code-resolved (the normal case).
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

-- 1. ItemCodeLookup
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ItemCodeLookup')
CREATE TABLE dbo.ItemCodeLookup (
  ItemCodeLookupId INT           PRIMARY KEY IDENTITY(1,1),
  ItemCode         NVARCHAR(50)  NOT NULL,
  ItemName         NVARCHAR(200) NOT NULL,
  Category         NVARCHAR(100) NULL,
  CreatedByUserId  INT           NULL REFERENCES dbo.Users(UserId),
  CreatedAt        DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
  UpdatedAt        DATETIME2     NOT NULL DEFAULT GETUTCDATE()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ItemCodeLookup_ItemCode')
  CREATE UNIQUE INDEX UQ_ItemCodeLookup_ItemCode ON dbo.ItemCodeLookup(ItemCode);
GO

-- Seed a handful of sample rows (from the user's Excel screenshot) so the
-- table isn't empty and the Admin page has something to show/edit before
-- the full list is pasted in.
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0001')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0001', 'Aglu Pectin Powder HS-R', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0002')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0002', 'Ammonium chloride', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0003')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0003', 'Ascorbic Acid Powder', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0004')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0004', 'Aspartame Powder', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0005')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0005', 'Banana Emulsion', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0006')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0006', 'Banana Flavour', 'INGREDIENTS');
IF NOT EXISTS (SELECT 1 FROM dbo.ItemCodeLookup WHERE ItemCode = 'ING-0007')
  INSERT INTO dbo.ItemCodeLookup (ItemCode, ItemName, Category) VALUES ('ING-0007', 'Beef flavour - Powder', 'INGREDIENTS');
GO

-- 2. RequisitionItems.ItemCode — preserves the raw code alongside the
--    resolved friendly ItemName.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'ItemCode')
  ALTER TABLE dbo.RequisitionItems ADD ItemCode NVARCHAR(50) NULL;
GO

PRINT 'Migration complete — ItemCodeLookup table added.';
GO
