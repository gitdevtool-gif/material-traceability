-- ============================================================
-- Adds 'Viewer' (System Viewer) to the Users.Role check constraint.
--
-- Read-only role: can open every page except User Management, but
-- every create/update/delete is rejected server-side
-- (middleware/auth.js). No other schema change is needed.
--
-- Safe to re-run: drops whatever the existing role constraint is
-- named and recreates it with the full allowed list, same pattern as
-- add-production-manager-role.sql.
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
    'OpsManager','FactoryQA','Procurement','Director','ProductionManager',
    'Viewer'
  )
);
GO

PRINT 'Viewer role added to Users.Role check constraint.';
GO
