-- ============================================================
-- GRN check reasons before the Director approves (2026-11-23)
--
-- The GRN Approval page flags checks on a GRN (price above PO, quantity vs
-- weighbridge, QA rejection not applied, ticket reused, no PO, changed in
-- Busy after approval, billed before approval). A new 'GrnReviewer' role
-- writes the reason for each flagged check; the Director sees the reason
-- under the check and can approve only once every flagged check has one
-- (or approves anyway with a written override note).
--
--   GrnCheckReasons  one row per GRN + check. CheckKey = check code + a hash
--                    of the check's text, so when the GRN changes in Busy and
--                    the difference changes, the old reason no longer applies
--                    and a new one is needed.
--
-- Also adds the 'GrnReviewer' role. Safe to re-run.
-- ============================================================
SET NOCOUNT ON;

IF OBJECT_ID('dbo.GrnCheckReasons', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GrnCheckReasons (
    ReasonId     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_GrnCheckReasons PRIMARY KEY,
    GrnVchCode   INT            NOT NULL,
    CheckKey     VARCHAR(80)    NOT NULL,
    CheckCode    VARCHAR(40)    NOT NULL,
    CheckText    NVARCHAR(500)  NOT NULL,   -- the check as the reviewer saw it
    Reason       NVARCHAR(1000) NOT NULL,
    ReasonBy     INT            NOT NULL,
    ReasonAt     DATETIME2      NOT NULL CONSTRAINT DF_GrnCheckReasons_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_GrnCheckReasons UNIQUE (GrnVchCode, CheckKey)
  );
END
GO

-- 'GrnReviewer' role (same pattern as add-grn-director-approval.sql)
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
    'ProductionManager','Viewer','WorkshopHOD','Accounts','GrnReviewer'
  )
);
GO

PRINT 'GrnCheckReasons table and GrnReviewer role added.';
GO
