-- Migration 007: Add VehicleInspectionDone to QAInspections
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'VehicleInspectionDone'
)
BEGIN
    ALTER TABLE dbo.QAInspections ADD VehicleInspectionDone BIT DEFAULT 0;
END
GO
