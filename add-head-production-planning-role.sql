-- 2026-10-22: new role "HeadOfProductionPlanning" — Reorder Levels, FG Reorder,
-- Production Planning and Aging Analysis. Re-creates the Users.Role check
-- constraint with the new value added; existing values unchanged.
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Users_Role')
  ALTER TABLE dbo.Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE dbo.Users WITH CHECK ADD CONSTRAINT CK_Users_Role CHECK (
  [Role] IN ('Viewer', 'ProductionManager', 'HeadOfProductionPlanning', 'Director', 'Procurement', 'FactoryQA',
             'OpsManager', 'ProductionClerk', 'QAManager', 'QAInspector', 'Auditor', 'Supervisor',
             'FactoryReceiving', 'StoreReceiving', 'Weighbridge', 'GateSecurity', 'Admin')
);
GO
