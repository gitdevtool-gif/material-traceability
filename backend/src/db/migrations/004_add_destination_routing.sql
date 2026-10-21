-- Migration 004: Add Destination routing to DeliveryEntries
-- Two flows after weighbridge:
--   Raw materials -> QA Inspection -> Factory Receiving -> GRN
--   Other materials (ingredients, spare parts, packaging) -> Central Stores -> GRN
-- ============================================================

-- Add Destination column (NULL = not yet routed)
ALTER TABLE dbo.DeliveryEntries
  ADD Destination VARCHAR(20) NULL;
GO

-- Add CentralStoreReceived status to allow Central Store direct flow
-- Drop and recreate Status check constraint
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
      'CentralStoreReceived',
      'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'
    )
  );
GO
