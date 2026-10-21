-- ============================================================
-- Migration 015: Procurement Module
-- Adds: Procurement + Director roles, WhatsApp on Suppliers,
--       SupplierCategories, ItemCategoryMap, Requisitions,
--       RequisitionItems, RFQs, RFQDispatches, Quotations,
--       QuotationLineItems, QuoteEvaluations, LPOReconciliation
-- ============================================================

-- 1. Extend Users role constraint to include Procurement + Director
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
    'OpsManager','FactoryQA','Procurement','Director'
  )
);
GO

-- 2. Add WhatsApp column to Suppliers (idempotent)
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Suppliers') AND name = 'WhatsApp'
)
  ALTER TABLE dbo.Suppliers ADD WhatsApp VARCHAR(30) NULL;
GO

-- 3. SupplierCategories — many categories per supplier
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'SupplierCategories')
CREATE TABLE dbo.SupplierCategories (
  SupplierCategoryId  INT           PRIMARY KEY IDENTITY(1,1),
  SupplierId          INT           NOT NULL
                        REFERENCES dbo.Suppliers(SupplierId) ON DELETE CASCADE,
  Category            NVARCHAR(100) NOT NULL,
  CreatedAt           DATETIME2     DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_SupplierCategory UNIQUE (SupplierId, Category)
);
GO

-- 4. ItemCategoryMap — admin-managed pattern → category lookup
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ItemCategoryMap')
CREATE TABLE dbo.ItemCategoryMap (
  ItemCategoryMapId   INT           PRIMARY KEY IDENTITY(1,1),
  ItemPattern         NVARCHAR(200) NOT NULL,
  MatchType           VARCHAR(20)   NOT NULL DEFAULT 'contains'
                        CHECK (MatchType IN ('exact', 'contains', 'starts_with')),
  Category            NVARCHAR(100) NOT NULL,
  SortOrder           INT           NOT NULL DEFAULT 50,
  CreatedByUserId     INT           NULL,
  CreatedAt           DATETIME2     DEFAULT GETUTCDATE(),
  UpdatedAt           DATETIME2     DEFAULT GETUTCDATE()
);
GO

-- 5. Requisitions — one row per Busy PurIndents ordno
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Requisitions')
CREATE TABLE dbo.Requisitions (
  RequisitionId   INT            PRIMARY KEY IDENTITY(1,1),
  BusyOrdNo       VARCHAR(50)    NOT NULL,
  BusyDate        DATE           NOT NULL,
  Warehouse       NVARCHAR(100)  NULL,
  MatCenter       NVARCHAR(100)  NULL,
  SyncedAt        DATETIME2      DEFAULT GETUTCDATE(),
  Status          VARCHAR(30)    NOT NULL DEFAULT 'Pending'
                    CHECK (Status IN (
                      'Pending','RFQSent','QuotesReceived',
                      'EvaluationPending','Approved','Reconciled','Cancelled'
                    )),
  Notes           NVARCHAR(1000) NULL,
  CreatedAt       DATETIME2      DEFAULT GETUTCDATE(),
  UpdatedAt       DATETIME2      DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_Requisitions_BusyOrdNo UNIQUE (BusyOrdNo)
);
GO

-- 6. RequisitionItems — one row per PurIndents line item
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RequisitionItems')
CREATE TABLE dbo.RequisitionItems (
  RequisitionItemId   INT            PRIMARY KEY IDENTITY(1,1),
  RequisitionId       INT            NOT NULL
                        REFERENCES dbo.Requisitions(RequisitionId) ON DELETE CASCADE,
  ItemName            NVARCHAR(200)  NOT NULL,
  Qty                 DECIMAL(12,2)  NOT NULL,
  BusyPrice           DECIMAL(12,4)  NULL,   -- indicative price from Busy indent
  BusyAmt             DECIMAL(12,4)  NULL,
  Category            NVARCHAR(100)  NULL,   -- resolved via ItemCategoryMap
  CreatedAt           DATETIME2      DEFAULT GETUTCDATE()
);
GO

-- 7. RFQs — one per Requisition
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RFQs')
CREATE TABLE dbo.RFQs (
  RFQId           INT            PRIMARY KEY IDENTITY(1,1),
  RequisitionId   INT            NOT NULL REFERENCES dbo.Requisitions(RequisitionId),
  RFQNumber       VARCHAR(30)    NOT NULL,
  IssuedAt        DATETIME2      NULL,
  DeadlineAt      DATETIME2      NULL,
  IssuedByUserId  INT            NULL REFERENCES dbo.Users(UserId),
  Notes           NVARCHAR(1000) NULL,
  CreatedAt       DATETIME2      DEFAULT GETUTCDATE(),
  UpdatedAt       DATETIME2      DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_RFQs_RequisitionId UNIQUE (RequisitionId),
  CONSTRAINT UQ_RFQs_Number       UNIQUE (RFQNumber)
);
GO

-- 8. RFQDispatches — one per supplier per RFQ; holds the self-submit token
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RFQDispatches')
CREATE TABLE dbo.RFQDispatches (
  RFQDispatchId   INT              PRIMARY KEY IDENTITY(1,1),
  RFQId           INT              NOT NULL
                    REFERENCES dbo.RFQs(RFQId) ON DELETE CASCADE,
  SupplierId      INT              NOT NULL REFERENCES dbo.Suppliers(SupplierId),
  Channel         VARCHAR(20)      NOT NULL DEFAULT 'email'
                    CHECK (Channel IN ('email', 'whatsapp', 'phone')),
  SentAt          DATETIME2        NULL,
  Token           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
  TokenExpiresAt  DATETIME2        NULL,
  SentByUserId    INT              NULL REFERENCES dbo.Users(UserId),
  DispatchNotes   NVARCHAR(500)    NULL,
  CreatedAt       DATETIME2        DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_RFQDispatches_Token       UNIQUE (Token),
  CONSTRAINT UQ_RFQDispatches_RFQSupplier UNIQUE (RFQId, SupplierId)
);
GO

-- 9. Quotations — one response per supplier per RFQ
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Quotations')
CREATE TABLE dbo.Quotations (
  QuotationId         INT            PRIMARY KEY IDENTITY(1,1),
  RFQDispatchId       INT            NOT NULL
                        REFERENCES dbo.RFQDispatches(RFQDispatchId),
  RFQId               INT            NOT NULL REFERENCES dbo.RFQs(RFQId),
  SupplierId          INT            NOT NULL REFERENCES dbo.Suppliers(SupplierId),
  SubmittedAt         DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  SubmissionChannel   VARCHAR(20)    NOT NULL DEFAULT 'manual'
                        CHECK (SubmissionChannel IN ('email','phone','whatsapp','portal','manual')),
  ValidUntil          DATE           NULL,
  PaymentTerms        NVARCHAR(200)  NULL,
  DeliveryDays        INT            NULL,
  TotalAmount         DECIMAL(14,4)  NULL,
  Notes               NVARCHAR(1000) NULL,
  IsWithdrawn         BIT            NOT NULL DEFAULT 0,
  CreatedAt           DATETIME2      DEFAULT GETUTCDATE(),
  UpdatedAt           DATETIME2      DEFAULT GETUTCDATE()
);
GO

-- 10. QuotationLineItems — per-item pricing within a quotation
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'QuotationLineItems')
CREATE TABLE dbo.QuotationLineItems (
  QuotationLineItemId INT            PRIMARY KEY IDENTITY(1,1),
  QuotationId         INT            NOT NULL
                        REFERENCES dbo.Quotations(QuotationId) ON DELETE CASCADE,
  RequisitionItemId   INT            NOT NULL
                        REFERENCES dbo.RequisitionItems(RequisitionItemId),
  UnitPrice           DECIMAL(12,4)  NOT NULL,
  Qty                 DECIMAL(12,2)  NOT NULL,
  LineTotal           AS             (UnitPrice * Qty),
  Notes               NVARCHAR(500)  NULL
);
GO

-- 11. QuoteEvaluations — Director approves the winning quotation
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'QuoteEvaluations')
CREATE TABLE dbo.QuoteEvaluations (
  QuoteEvaluationId   INT            PRIMARY KEY IDENTITY(1,1),
  RFQId               INT            NOT NULL REFERENCES dbo.RFQs(RFQId),
  WinningQuotationId  INT            NOT NULL REFERENCES dbo.Quotations(QuotationId),
  DirectorUserId      INT            NOT NULL REFERENCES dbo.Users(UserId),
  ApprovedAt          DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  Notes               NVARCHAR(1000) NULL,
  CreatedAt           DATETIME2      DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_QuoteEvaluations_RFQId UNIQUE (RFQId)
);
GO

-- 12. LPOReconciliation — links Busy PurOrder back to our RFQ/evaluation
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'LPOReconciliation')
CREATE TABLE dbo.LPOReconciliation (
  LPOReconciliationId INT            PRIMARY KEY IDENTITY(1,1),
  RequisitionId       INT            NULL REFERENCES dbo.Requisitions(RequisitionId),
  QuoteEvaluationId   INT            NULL REFERENCES dbo.QuoteEvaluations(QuoteEvaluationId),
  BusyPurOrdNo        VARCHAR(50)    NOT NULL,
  BusySupplier        NVARCHAR(200)  NULL,
  BusyDate            DATE           NULL,
  TotalQuotedAmt      DECIMAL(14,4)  NULL,
  TotalActualAmt      DECIMAL(14,4)  NULL,
  BenchmarkAmt        DECIMAL(14,4)  NULL,
  VarianceAmt         DECIMAL(14,4)  NULL,  -- actual minus quoted, computed on insert
  ReconciledAt        DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  ReconciledByUserId  INT            NULL REFERENCES dbo.Users(UserId),
  Notes               NVARCHAR(1000) NULL,
  CreatedAt           DATETIME2      DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_LPOReconciliation_OrdNo UNIQUE (BusyPurOrdNo)
);
GO

PRINT 'Migration 015 complete — Procurement Module created.';
GO
