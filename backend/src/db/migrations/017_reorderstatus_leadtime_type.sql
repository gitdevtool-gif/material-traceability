-- ============================================================
-- Migration 017: Fix ReorderStatus.LeadTime column
-- Renames LeadTimeDays → LeadTime and changes INT → DECIMAL(5,2)
-- to correctly store the ERP view's leadtime_week/4 value
-- (which is in months, e.g. 0.5 = half a month / ~2 weeks).
-- Idempotent — safe to re-run.
-- ============================================================

-- Step 1: rename INT column to LeadTime (if it still has the old name)
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.ReorderStatus')
    AND name = 'LeadTimeDays'
)
  EXEC sp_rename 'dbo.ReorderStatus.LeadTimeDays', 'LeadTime', 'COLUMN';
GO

-- Step 2: widen type to DECIMAL(5,2) so 0.5 is stored without rounding
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.ReorderStatus')
    AND name = 'LeadTime'
    AND system_type_id = TYPE_ID('int')
)
  ALTER TABLE dbo.ReorderStatus
    ALTER COLUMN LeadTime DECIMAL(5,2) NULL;
GO
