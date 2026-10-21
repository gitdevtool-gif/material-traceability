-- ============================================================
-- Migration: Per-item Ops Manager approval + requisition Hold
--
-- 1. Requisitions.Status gains 'OnHold' — an Ops Manager can pause a
--    requisition (e.g. needs more info, waiting on a stock recount)
--    without approving or rejecting it outright. Held requisitions stay
--    out of Procurement's queue but remain visible to the Ops Manager
--    to revisit and decide later.
--
-- 2. dbo.RequisitionItemApprovals — one row per RequisitionItem holding
--    the Ops Manager's per-item decision (Approved/Rejected), instead of
--    the previous all-or-nothing whole-requisition decision. A
--    requisition moves to 'Pending' (enters Procurement's RFQ flow) as
--    soon as AT LEAST ONE item is approved; rfq.routes.js excludes any
--    item marked Rejected here from what gets dispatched to suppliers.
--    Only goes to 'RejectedByOps' if EVERY item was rejected.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

-- 1. Widen the Requisitions.Status check constraint to add 'OnHold'.
DECLARE @ckName NVARCHAR(200);
SELECT @ckName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Requisitions' AND c.name = 'Status';

IF @ckName IS NOT NULL
  EXEC('ALTER TABLE dbo.Requisitions DROP CONSTRAINT [' + @ckName + ']');
GO

ALTER TABLE dbo.Requisitions
ADD CONSTRAINT CK_Requisitions_Status CHECK (
  Status IN (
    'PendingOpsApproval','OnHold','RejectedByOps',
    'Pending','RFQSent','QuotesReceived','EvaluationPending',
    'Approved','Reconciled','Cancelled'
  )
);
GO

-- 2. Hold tracking columns on Requisitions.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'HoldReason')
  ALTER TABLE dbo.Requisitions ADD HoldReason NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'HoldByUserId')
  ALTER TABLE dbo.Requisitions ADD HoldByUserId INT NULL REFERENCES dbo.Users(UserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'HoldAt')
  ALTER TABLE dbo.Requisitions ADD HoldAt DATETIME2 NULL;
GO

-- 3. Per-item Ops decision table.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RequisitionItemApprovals')
CREATE TABLE dbo.RequisitionItemApprovals (
  RequisitionItemApprovalId INT            PRIMARY KEY IDENTITY(1,1),
  RequisitionItemId         INT            NOT NULL UNIQUE
                              REFERENCES dbo.RequisitionItems(RequisitionItemId) ON DELETE CASCADE,
  Decision                  VARCHAR(20)    NOT NULL CHECK (Decision IN ('Approved', 'Rejected')),
  ApprovedQty                DECIMAL(12,2) NULL,
  RejectionReason            NVARCHAR(500) NULL,
  DecidedByUserId            INT           NULL REFERENCES dbo.Users(UserId),
  DecidedAt                  DATETIME2     NOT NULL DEFAULT GETUTCDATE()
);
GO

PRINT 'Migration complete — RequisitionItemApprovals table + OnHold status added.';
GO
