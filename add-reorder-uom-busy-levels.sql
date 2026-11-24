-- 2026-10-22: Reorder Levels page — the item's unit of measure, and the
-- critical levels set on the item in Busy (Item master → Critical Levels:
-- Master1.D5 = minimum, D6 = reorder, D7 = maximum level), shown next to the
-- levels this system computes from consumption. Filled by reorder-sync.
IF COL_LENGTH('dbo.ReorderStatus', 'UOM') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD UOM NVARCHAR(20) NULL;
GO
IF COL_LENGTH('dbo.ReorderStatus', 'BusyMinLevel') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD BusyMinLevel FLOAT NULL;
GO
IF COL_LENGTH('dbo.ReorderStatus', 'BusyReorderLevel') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD BusyReorderLevel FLOAT NULL;
GO
IF COL_LENGTH('dbo.ReorderStatus', 'BusyMaxLevel') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD BusyMaxLevel FLOAT NULL;
GO
