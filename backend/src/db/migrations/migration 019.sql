-- ============================================================
-- Migration 021: Ops Manager approval gate on synced Requisitions
--
-- New flow:
--   Busy sync -> dbo.Requisitions (Status = 'PendingOpsApproval')
--     -> Ops Manager reviews items against dbo.ReorderStatus
--        (live stock, matched by ItemName) to judge if it's
--        genuinely still needed
--     -> Approves  -> Status = 'Pending'      (existing Procurement
--                     flow, RFQ dispatch, untouched from here)
--     -> Rejects   -> Status = 'RejectedByOps' (dead-ends, never
--                     reaches Procurement)
--
-- Run migration_020_rollback_production_requests.sql BEFORE this one.
--
-- NOTE: this does NOT retroactively change the Status of rows synced
-- before this deployment — they keep whatever Status they already
-- have. Only rows synced after this deployment (see the updated
-- procurement-sync.service.js) get 'PendingOpsApproval'.
--
-- Safe to re-run: every step is guarded with an existence check.
-- ============================================================

SET NOCOUNT ON;

-- 1. Widen the Requisitions.Status check constraint with the two new values.
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
    'PendingOpsApproval','RejectedByOps',
    'Pending','RFQSent','QuotesReceived','EvaluationPending',
    'Approved','Reconciled','Cancelled'
  )
);
GO

-- 2. Ops-approval decision columns.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'OpsApprovedByUserId')
  ALTER TABLE dbo.Requisitions ADD OpsApprovedByUserId INT NULL REFERENCES dbo.Users(UserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'OpsApprovedAt')
  ALTER TABLE dbo.Requisitions ADD OpsApprovedAt DATETIME2 NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'OpsRejectionReason')
  ALTER TABLE dbo.Requisitions ADD OpsRejectionReason NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'OpsNotes')
  ALTER TABLE dbo.Requisitions ADD OpsNotes NVARCHAR(1000) NULL;
GO

PRINT 'Migration 021 complete — Ops Manager approval gate added to Requisitions.';
GO