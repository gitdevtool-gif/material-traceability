-- 2026-10-22: FG Reorder Levels page — unit of measure and the critical
-- levels set on the item in Busy (Master1.D5 = minimum, D6 = reorder,
-- D7 = maximum), as on the raw-material Reorder Levels page.
IF COL_LENGTH('dbo.FGReorderStatus', 'UOM') IS NULL
  ALTER TABLE dbo.FGReorderStatus ADD UOM NVARCHAR(20) NULL;
GO
IF COL_LENGTH('dbo.FGReorderStatus', 'BusyMinLevel') IS NULL
  ALTER TABLE dbo.FGReorderStatus ADD BusyMinLevel DECIMAL(14,2) NULL;
GO
IF COL_LENGTH('dbo.FGReorderStatus', 'BusyReorderLevel') IS NULL
  ALTER TABLE dbo.FGReorderStatus ADD BusyReorderLevel DECIMAL(14,2) NULL;
GO
IF COL_LENGTH('dbo.FGReorderStatus', 'BusyMaxLevel') IS NULL
  ALTER TABLE dbo.FGReorderStatus ADD BusyMaxLevel DECIMAL(14,2) NULL;
GO
