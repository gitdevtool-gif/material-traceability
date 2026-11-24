-- ============================================================
-- GRN Director approval before payment (2026-11-11)
--
-- Every Busy GRN (Mat. Rcvd. from Party, series GRN) waits for a Director's
-- approval before Accounts pay it — replacing the paper copy with the
-- weighbridge ticket attached. The Director sees the whole trail here (PO,
-- gate, weighbridge, QA, GRN lines and price checks); Accounts see which
-- approved GRNs are billed / paid in Busy. Bills and payments stay in Busy.
--
--   GrnApprovals       one row per Busy GRN (VchCode), its current state
--   GrnApprovalEvents  every step: queued, approved, queried, resubmitted,
--                      changed in Busy after approval, deleted in Busy
--
-- Also adds the 'Accounts' role. Safe to re-run.
-- ============================================================
SET NOCOUNT ON;

IF OBJECT_ID('dbo.GrnApprovals', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GrnApprovals (
    GrnVchCode           INT            NOT NULL CONSTRAINT PK_GrnApprovals PRIMARY KEY,
    GrnNo                NVARCHAR(50)   NOT NULL,
    GrnDate              DATE           NOT NULL,
    PartyCode            INT            NULL,
    PartyName            NVARCHAR(200)  NULL,
    Amount               DECIMAL(18,2)  NOT NULL,          -- Busy total at the last sync
    Signature            VARCHAR(64)    NOT NULL,          -- hash of amount + lines, to spot changes in Busy
    EntryId              INT            NULL,              -- gate entry linked to this GRN, if any
    Status               VARCHAR(20)    NOT NULL CONSTRAINT DF_GrnApprovals_Status DEFAULT 'Pending', -- Pending | Approved | Queried | Deleted
    ApprovedBy           INT            NULL,
    ApprovedAt           DATETIME2      NULL,
    ApprovedAmount       DECIMAL(18,2)  NULL,
    ApprovedSignature    VARCHAR(64)    NULL,
    ApprovalNote         NVARCHAR(500)  NULL,
    QueriedBy            INT            NULL,
    QueriedAt            DATETIME2      NULL,
    QueryReason          NVARCHAR(1000) NULL,
    ResubmittedBy        INT            NULL,
    ResubmittedAt        DATETIME2      NULL,
    ResubmitNote         NVARCHAR(1000) NULL,
    ChangedAfterApproval BIT            NOT NULL CONSTRAINT DF_GrnApprovals_Changed DEFAULT 0,
    FirstSeenAt          DATETIME2      NOT NULL CONSTRAINT DF_GrnApprovals_FirstSeen DEFAULT SYSUTCDATETIME(),
    UpdatedAt            DATETIME2      NOT NULL CONSTRAINT DF_GrnApprovals_Updated DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_GrnApprovals_Status ON dbo.GrnApprovals (Status, GrnDate DESC);
  CREATE INDEX IX_GrnApprovals_Entry ON dbo.GrnApprovals (EntryId);
END
GO

IF OBJECT_ID('dbo.GrnApprovalEvents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GrnApprovalEvents (
    EventId     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_GrnApprovalEvents PRIMARY KEY,
    GrnVchCode  INT            NOT NULL,
    Action      VARCHAR(30)    NOT NULL,  -- Queued | Approved | Queried | Resubmitted | ChangedInBusy | DeletedInBusy
    UserId      INT            NULL,      -- NULL = the sync
    At          DATETIME2      NOT NULL CONSTRAINT DF_GrnApprovalEvents_At DEFAULT SYSUTCDATETIME(),
    Amount      DECIMAL(18,2)  NULL,
    Notes       NVARCHAR(1000) NULL
  );
  CREATE INDEX IX_GrnApprovalEvents_Grn ON dbo.GrnApprovalEvents (GrnVchCode, At);
END
GO

-- 'Accounts' role (same pattern as add-workshop-hod-role.sql)
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
    'ProductionManager','Viewer','WorkshopHOD','Accounts'
  )
);
GO
