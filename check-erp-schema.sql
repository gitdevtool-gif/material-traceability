

USE [BusyComp0006_db12026];
GO

GRANT SELECT ON dbo.PurIndents TO [o2d];
GRANT SELECT ON dbo.PurOrder   TO [o2d];
GO

-- Verify the grants took effect
SELECT
    dp.name        AS principal,
    o.name         AS object_name,
    p.permission_name,
    p.state_desc
FROM sys.database_permissions p
JOIN sys.objects o              ON o.object_id = p.major_id
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
WHERE o.name IN ('PurIndents','PurOrder')
  AND dp.name = 'o2d';
GO

