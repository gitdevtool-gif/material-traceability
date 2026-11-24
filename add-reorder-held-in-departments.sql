-- Reorder Levels on the inventory stores (2026-11-11): live stock = Central
-- Stores + F7; stock of the item still sitting in departments / factories is
-- kept here for information (it is not counted as available).
IF COL_LENGTH('dbo.ReorderStatus', 'HeldInDepartments') IS NULL
  ALTER TABLE dbo.ReorderStatus ADD HeldInDepartments FLOAT NULL;
GO
