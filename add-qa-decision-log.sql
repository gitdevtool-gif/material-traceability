-- QA decision log (2026-11-11): a fixed copy of every QA decision as it was
-- submitted — entry, checks, test results, quantities, remarks, rejection
-- reason — so the inspector keeps a record for reference. One row per
-- decision (a Quarantine decided again later adds another row). No foreign
-- key to QAInspections on purpose: the copy outlives an inspection that
-- Admin deletes or QA redoes.
IF OBJECT_ID('dbo.QADecisionLog', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.QADecisionLog (
    LogId         INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_QADecisionLog PRIMARY KEY,
    InspectionId  INT            NOT NULL,
    InspectionNo  VARCHAR(20)    NOT NULL,
    EntryId       INT            NOT NULL,
    EntryNo       VARCHAR(20)    NOT NULL,
    Decision      VARCHAR(20)    NOT NULL,
    AcceptedQty   DECIMAL(12,2)  NULL,
    RejectedQty   DECIMAL(12,2)  NULL,
    InspectorId   INT            NULL,      -- who did the inspection / tests
    SubmittedBy   INT            NOT NULL,  -- who submitted the decision
    SubmittedAt   DATETIME2      NOT NULL CONSTRAINT DF_QADecisionLog_SubmittedAt DEFAULT SYSUTCDATETIME(),
    Source        VARCHAR(20)    NOT NULL CONSTRAINT DF_QADecisionLog_Source DEFAULT 'Submitted', -- Submitted | Backfill
    Snapshot      NVARCHAR(MAX)  NOT NULL   -- JSON: everything shown on the copy
  );
  CREATE INDEX IX_QADecisionLog_SubmittedBy ON dbo.QADecisionLog (SubmittedBy, SubmittedAt DESC);
  CREATE INDEX IX_QADecisionLog_InspectorId ON dbo.QADecisionLog (InspectorId, SubmittedAt DESC);
  CREATE INDEX IX_QADecisionLog_Inspection ON dbo.QADecisionLog (InspectionId);
END
GO
