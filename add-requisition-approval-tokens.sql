-- ============================================================
-- Migration: Requisition Ops-Approval email tokens
--
-- Mirrors dbo.ApprovalTokens (used by the Goods Receiving QA-approval
-- email flow in opsmanager.routes.js) but scoped to dbo.Requisitions
-- instead of dbo.DeliveryEntries — those two entities are unrelated, so
-- ApprovalTokens' FK to DeliveryEntries can't be reused here without
-- either breaking that FK or silently pointing it at the wrong table.
--
-- Two tokens are issued per requisition when it lands in
-- 'PendingOpsApproval' (procurement-sync.service.js): one for "Approve
-- All" (every item at its full requested qty — the same as clicking
-- "Approve All" then "Submit Decision" in the app), one for "Hold for
-- Review" (puts the whole requisition on hold, no reason required).
-- Deliberately no one-click "Reject" token — requisition-approval.routes.js
-- requires a reason per rejected item, which a single email click can't
-- meaningfully supply; an Ops Manager who wants to reject items logs in
-- and uses the per-item review screen instead.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF OBJECT_ID('dbo.RequisitionApprovalTokens', 'U') IS NULL
CREATE TABLE dbo.RequisitionApprovalTokens (
    TokenId         INT PRIMARY KEY IDENTITY(1,1),
    Token           VARCHAR(100)  NOT NULL,
    RequisitionId   INT           NOT NULL,
    BusyOrdNo       VARCHAR(50)   NOT NULL,
    Action          VARCHAR(10)   NULL,       -- NULL until used, then 'approve' or 'hold'
    IsUsed          BIT           NOT NULL DEFAULT 0,
    ExpiresAt       DATETIME2     NOT NULL,
    UsedAt          DATETIME2     NULL,
    CreatedAt       DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_RequisitionApprovalTokens_Token UNIQUE (Token),
    CONSTRAINT FK_RequisitionApprovalTokens_Requisition
      FOREIGN KEY (RequisitionId) REFERENCES dbo.Requisitions(RequisitionId)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RequisitionApprovalTokens_Token' AND object_id = OBJECT_ID('dbo.RequisitionApprovalTokens'))
  CREATE INDEX IX_RequisitionApprovalTokens_Token ON dbo.RequisitionApprovalTokens(Token);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RequisitionApprovalTokens_RequisitionId' AND object_id = OBJECT_ID('dbo.RequisitionApprovalTokens'))
  CREATE INDEX IX_RequisitionApprovalTokens_RequisitionId ON dbo.RequisitionApprovalTokens(RequisitionId);
GO

PRINT 'RequisitionApprovalTokens table created.';
GO
