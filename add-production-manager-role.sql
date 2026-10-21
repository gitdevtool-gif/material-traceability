-- ============================================================
-- Adds 'ProductionManager' to the Users.Role check constraint.
--
-- This role can view: Reorder Levels, FG Reorder Levels,
-- Production Planning, and Aging Analysis pages (read-only,
-- same access level as Director on these four pages).
--
-- Safe to re-run: drops whatever the existing role constraint is
-- named (name has varied across past migrations) and recreates it
-- with the full allowed list, matching the style of prior role
-- migrations (008, 013, 015).
-- ============================================================

SET NOCOUNT ON;

DECLARE @ckName NVARCHAR(200);
SELECT @ckName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Users' AND c.name = 'Role';

IF @ckName IS NOT NULL
  EXEC('ALTER TABLE dbo.Users DROP CONSTRAINT [' + @ckName + ']');
GO

ALTER TABLE dbo.Users
ADD CONSTRAINT CK_Users_Role CHECK (
  Role IN (
    'Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving',
    'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk',
    'OpsManager','FactoryQA','Procurement','Director','ProductionManager'
  )
);
GO

PRINT 'ProductionManager role added to Users.Role check constraint.';
GO
