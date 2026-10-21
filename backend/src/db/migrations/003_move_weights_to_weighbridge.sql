-- Migration 003: Remove weight columns from DeliveryEntries (weights now recorded only at Weighbridge)
-- ============================================================

-- Drop CHECK constraints on weight columns
DECLARE @constraintName NVARCHAR(200);

SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'FirstWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);

SET @constraintName = NULL;
SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'SecondWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);

SET @constraintName = NULL;
SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'NetWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);
GO

-- Make weight columns nullable (they will be NULL for gate entries, filled via weighbridge)
ALTER TABLE dbo.DeliveryEntries ALTER COLUMN FirstWeight DECIMAL(10,2) NULL;
ALTER TABLE dbo.DeliveryEntries ALTER COLUMN SecondWeight DECIMAL(10,2) NULL;
ALTER TABLE dbo.DeliveryEntries ALTER COLUMN NetWeight DECIMAL(10,2) NULL;
GO
