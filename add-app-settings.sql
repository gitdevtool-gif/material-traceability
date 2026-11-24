-- System Settings (2026-10-27): settings Admin changes from the UI instead
-- of a code change. One row per setting; the value is JSON.
-- First setting: the Raise Order units of measure ('requisition.units').
IF OBJECT_ID('dbo.AppSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.AppSettings (
    SettingKey   VARCHAR(100)   NOT NULL CONSTRAINT PK_AppSettings PRIMARY KEY,
    SettingValue NVARCHAR(MAX)  NOT NULL,
    UpdatedBy    INT            NULL,
    UpdatedAt    DATETIME2      NOT NULL CONSTRAINT DF_AppSettings_UpdatedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.AppSettings WHERE SettingKey = 'requisition.units')
  INSERT INTO dbo.AppSettings (SettingKey, SettingValue)
  VALUES ('requisition.units', N'["Kgs","Pcs","Metres","Litres","Set","Rim","Rolls"]');
GO
