-- Migration 008: Add Operational Manager Approval step
-- New workflow: QA Accepted → Ops Manager Review → OpsManagerApproved → Receiving
-- ============================================================

-- 1. Add OpsManagerApproved status to DeliveryEntries
DECLARE @statusConstraint NVARCHAR(200);
SELECT @statusConstraint = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'Status';

IF @statusConstraint IS NOT NULL
  EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @statusConstraint);
GO

ALTER TABLE dbo.DeliveryEntries
  ADD CONSTRAINT CK_DeliveryEntries_Status CHECK (
    Status IN (
      'GateReceived','WeighbridgePending','WeighbridgeCompleted',
      'QAPending','QAInProgress','QAAccepted','QARejected','Quarantine',
      'CentralStoreReceived','OpsManagerApproved',
      'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'
    )
  );
GO

-- 2. Add Ops Manager approval columns to QAInspections
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'OpsManagerId')
  ALTER TABLE dbo.QAInspections ADD OpsManagerId INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'OpsManagerApprovedAt')
  ALTER TABLE dbo.QAInspections ADD OpsManagerApprovedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'OpsManagerRemarks')
  ALTER TABLE dbo.QAInspections ADD OpsManagerRemarks NVARCHAR(1000) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.QAInspections') AND name = 'OpsManagerDecision')
  ALTER TABLE dbo.QAInspections ADD OpsManagerDecision VARCHAR(20) NULL;
GO

-- 3. Add OpsManager role to Users check constraint
DECLARE @ckNameUser NVARCHAR(200);
SELECT @ckNameUser = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Users' AND c.name = 'Role';

IF @ckNameUser IS NOT NULL
  EXEC('ALTER TABLE dbo.Users DROP CONSTRAINT [' + @ckNameUser + ']');
GO

ALTER TABLE dbo.Users
ADD CONSTRAINT CK_Users_Role CHECK (
  Role IN ('Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving',
           'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk','OpsManager')
);
GO

PRINT 'Migration 008 complete — Ops Manager approval step added.';
GO
