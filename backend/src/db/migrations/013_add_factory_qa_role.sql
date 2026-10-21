-- ============================================================
-- Migration 013: Add FactoryQA role
-- FactoryQA users can:
--   - Perform QA inspections (like QAInspector)
--   - Give QA pass/reject decisions (like QAManager)
--   - Receive factory GRN (like FactoryReceiving)
-- ============================================================

-- Drop the existing role check constraint (name may vary)
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
  Role IN ('Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving',
           'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk','OpsManager',
           'FactoryQA')
);
GO

PRINT 'Migration 013 complete — FactoryQA role added to Users constraint.';
GO
