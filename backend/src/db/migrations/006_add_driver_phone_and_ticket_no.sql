-- ============================================================
-- Migration 006: Add DriverPhone to DeliveryEntries, TicketNo to WeighbridgeRecords
-- ============================================================

-- Add DriverPhone column to DeliveryEntries
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.DeliveryEntries') AND name = 'DriverPhone')
    ALTER TABLE dbo.DeliveryEntries ADD DriverPhone VARCHAR(20) NULL;
GO

-- Add TicketNo column to WeighbridgeRecords
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.WeighbridgeRecords') AND name = 'TicketNo')
    ALTER TABLE dbo.WeighbridgeRecords ADD TicketNo VARCHAR(50) NULL;
GO

-- Add factory locations F1-F9
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F1')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F1', 'Factory', 'Factory 1');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F2')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F2', 'Factory', 'Factory 2');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F3')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F3', 'Factory', 'Factory 3');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F4')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F4', 'Factory', 'Factory 4');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F5')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F5', 'Factory', 'Factory 5');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F6')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F6', 'Factory', 'Factory 6');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F7')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F7', 'Factory', 'Factory 7');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F8')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F8', 'Factory', 'Factory 8');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F9')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F9', 'Factory', 'Factory 9');
GO
