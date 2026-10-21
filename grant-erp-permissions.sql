

USE [BusyComp0006_db12026];
GO

-- Grant SELECT on views used by the Material Traceability system
GRANT SELECT ON dbo.PurIndents TO [o2d];
GRANT SELECT ON dbo.PurOrder   TO [o2d];
GRANT SELECT ON dbo.reorder    TO [o2d];   -- required by reorder-sync.service.js
-- Read by routes/procurement/busy-lpo.routes.js (LPO raised in Busy, 2026-10-15)
GRANT SELECT ON dbo.Tran1      TO [o2d];
GRANT SELECT ON dbo.Tran2      TO [o2d];
GRANT SELECT ON dbo.Tran12     TO [o2d];
GRANT SELECT ON dbo.Master1    TO [o2d];
GO

-- Verify: should return 2 rows showing GRANT for o2d
SELECT
    dp.name           AS [User],
    o.name            AS [Object],
    p.permission_name AS [Permission],
    p.state_desc      AS [State]
FROM sys.database_permissions p
JOIN sys.objects              o  ON o.object_id      = p.major_id
JOIN sys.database_principals  dp ON dp.principal_id  = p.grantee_principal_id
WHERE o.name IN ('PurIndents', 'PurOrder')
  AND dp.name = 'o2d';
GO

-- Quick smoke test: if you see rows here, permissions are working
SELECT TOP 2
    LTRIM(RTRIM([ordno]))    AS ordno,
    LTRIM(RTRIM([itemName])) AS itemName,
    [Qty], [ApprovalStatus]
FROM dbo.PurIndents
WHERE ApprovalStatus = 0
ORDER BY [Date] DESC;
GO

SELECT TOP 2
    LTRIM(RTRIM([ordno]))    AS ordno,
    LTRIM(RTRIM([Supplier])) AS Supplier,
    LTRIM(RTRIM([itemName])) AS itemName,
    [Qty], [Price], [ApprovalStatus]
FROM dbo.PurOrder
ORDER BY [Date] DESC;
GO
