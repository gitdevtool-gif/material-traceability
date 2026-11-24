-- ============================================================
-- Adds 'WorkshopHOD' (Workshop Head of Department) to the
-- Users.Role check constraint (2026-10-22).
--
-- Requisitions raised on Mat Centre "Workshop" now wait for the Workshop
-- HOD to approve (or reject / hold) each item before Procurement can see
-- them, same flow as the Ops Manager gate for the factory floors. No other
-- schema change is needed. Admin and Director can decide either gate.
--
-- Safe to re-run: drops the existing role constraint and recreates it
-- with the full allowed list (same pattern as add-viewer-role.sql).
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
    'OpsManager','FactoryQA','Procurement','Director','HeadOfProductionPlanning',
    'ProductionManager','Viewer','WorkshopHOD'
  )
);
GO

PRINT 'WorkshopHOD role added to Users.Role check constraint.';
GO
