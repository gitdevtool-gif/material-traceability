-- Migration 010: Add LocationId to DeliveryEntries
-- Location is now specified at weighbridge stage instead of GRN stage
-- ============================================================

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.DeliveryEntries') AND name = 'LocationId'
)
BEGIN
  ALTER TABLE dbo.DeliveryEntries
    ADD LocationId INT NULL;

  ALTER TABLE dbo.DeliveryEntries
    ADD CONSTRAINT FK_DeliveryEntries_Location
    FOREIGN KEY (LocationId) REFERENCES dbo.StockLocations(LocationId);
END
GO
