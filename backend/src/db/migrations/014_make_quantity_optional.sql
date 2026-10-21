-- Migration: Make Quantity field optional in DeliveryEntryItems
ALTER TABLE dbo.DeliveryEntryItems ALTER COLUMN Quantity DECIMAL(12,2) NULL;
