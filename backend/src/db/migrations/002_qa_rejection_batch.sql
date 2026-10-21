-- ============================================================
-- Material Traceability System - Migration 002
-- QA Inspection, Batch Numbers, Goods Rejection, ERP Integration
-- ============================================================

-- ============================================================
-- Drop new tables if re-running (reverse dependency order)
-- ============================================================
IF OBJECT_ID('dbo.GoodsRejectionItems', 'U') IS NOT NULL DROP TABLE dbo.GoodsRejectionItems;
IF OBJECT_ID('dbo.GoodsRejectionNotes', 'U') IS NOT NULL DROP TABLE dbo.GoodsRejectionNotes;
IF OBJECT_ID('dbo.QATestResults', 'U') IS NOT NULL DROP TABLE dbo.QATestResults;
IF OBJECT_ID('dbo.QAInspections', 'U') IS NOT NULL DROP TABLE dbo.QAInspections;
GO

-- ============================================================
-- 1. Expand Delivery Entry statuses to include QA steps
-- ============================================================
ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT IF EXISTS CK__DeliveryE__Statu___________;
GO

-- Drop the existing check constraint (name may vary)
DECLARE @ckName NVARCHAR(200);
SELECT @ckName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'Status';

IF @ckName IS NOT NULL
  EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT [' + @ckName + ']');
GO

ALTER TABLE dbo.DeliveryEntries
ADD CONSTRAINT CK_DeliveryEntries_Status CHECK (
  Status IN (
    'GateReceived','WeighbridgePending','WeighbridgeCompleted',
    'QAPending','QAInProgress','QAAccepted','QARejected','Quarantine',
    'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'
  )
);
GO

PRINT 'DeliveryEntries status constraint updated.';
GO

-- ============================================================
-- 2. Add BatchNo column to GRN Items
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GRNItems') AND name = 'BatchNo')
  ALTER TABLE dbo.GRNItems ADD BatchNo VARCHAR(30) NULL;
GO

-- Also add BatchNo to the GRN header for the overall batch
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GoodsReceiptNotes') AND name = 'BatchNo')
  ALTER TABLE dbo.GoodsReceiptNotes ADD BatchNo VARCHAR(30) NULL;
GO

PRINT 'BatchNo columns added.';
GO

-- ============================================================
-- 3. QA INSPECTIONS
-- ============================================================
CREATE TABLE dbo.QAInspections (
    InspectionId    INT PRIMARY KEY IDENTITY(1,1),
    InspectionNo    VARCHAR(20)   NOT NULL,  -- e.g. QA-20260330-0001
    EntryId         INT           NOT NULL,
    InspectionDate  DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    InspectorId     INT           NOT NULL,
    OverallStatus   VARCHAR(20)   NOT NULL DEFAULT 'Pending'
        CHECK (OverallStatus IN ('Pending','InProgress','Accepted','Rejected','Quarantine','Conditional')),
    COAProvided     BIT           DEFAULT 0,
    COAReference    VARCHAR(100),            -- COA document reference number
    COAFilePath     NVARCHAR(500),           -- path to uploaded COA scan
    SamplesTaken    BIT           DEFAULT 0,
    PhysicalCheckDone BIT         DEFAULT 0,
    OverallRemarks  NVARCHAR(1000),
    AcceptedQty     DECIMAL(12,2),
    RejectedQty     DECIMAL(12,2),
    ApprovedBy      INT,                     -- QA Manager who approved/rejected
    ApprovedAt      DATETIME2,
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_QAInspections_InspectionNo UNIQUE (InspectionNo),
    CONSTRAINT UQ_QAInspections_EntryId UNIQUE (EntryId),
    CONSTRAINT FK_QAInspections_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_QAInspections_Inspector FOREIGN KEY (InspectorId) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_QAInspections_Approver FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_QAInspections_Status ON dbo.QAInspections(OverallStatus);
CREATE INDEX IX_QAInspections_Date ON dbo.QAInspections(InspectionDate);
GO

-- ============================================================
-- 4. QA TEST RESULTS (per material item per inspection)
-- ============================================================
CREATE TABLE dbo.QATestResults (
    TestResultId    BIGINT PRIMARY KEY IDENTITY(1,1),
    InspectionId    INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    TestName        NVARCHAR(100) NOT NULL,  -- e.g. 'Moisture Content', 'pH Level', 'Visual Check'
    TestMethod      NVARCHAR(200),           -- e.g. 'Lab analysis', 'Visual inspection'
    ExpectedValue   NVARCHAR(100),           -- e.g. '<12%', '6.0-7.0'
    ActualValue     NVARCHAR(100),           -- actual measured value
    Result          VARCHAR(20)   NOT NULL DEFAULT 'Pending'
        CHECK (Result IN ('Pending','Pass','Fail','Conditional')),
    Remarks         NVARCHAR(500),
    TestedBy        INT           NOT NULL,
    TestedAt        DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_QATestResults_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
    CONSTRAINT FK_QATestResults_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId),
    CONSTRAINT FK_QATestResults_TestedBy FOREIGN KEY (TestedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_QATestResults_InspectionId ON dbo.QATestResults(InspectionId);
GO

-- ============================================================
-- 5. GOODS REJECTION NOTES
-- ============================================================
CREATE TABLE dbo.GoodsRejectionNotes (
    RejectionId     INT PRIMARY KEY IDENTITY(1,1),
    RejectionNo     VARCHAR(20)   NOT NULL,  -- e.g. REJ-20260330-0001
    EntryId         INT           NOT NULL,
    InspectionId    INT,                     -- links to QA inspection that triggered rejection
    RejectionDate   DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    RejectedBy      INT           NOT NULL,
    RejectionReason NVARCHAR(1000) NOT NULL,
    SupplierNotified BIT          DEFAULT 0,
    ReturnDate      DATE,                    -- expected/actual return date
    ReturnVehicleRegNo VARCHAR(20),
    ReturnWeighbridgeRef VARCHAR(50),
    ApprovedBy      INT,                     -- QA Manager / Production Manager
    ApprovedAt      DATETIME2,
    Notes           NVARCHAR(500),
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_GoodsRejection_RejectionNo UNIQUE (RejectionNo),
    CONSTRAINT UQ_GoodsRejection_EntryId UNIQUE (EntryId),
    CONSTRAINT FK_GoodsRejection_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_GoodsRejection_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
    CONSTRAINT FK_GoodsRejection_RejectedBy FOREIGN KEY (RejectedBy) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_GoodsRejection_ApprovedBy FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_GoodsRejection_Date ON dbo.GoodsRejectionNotes(RejectionDate);
GO

-- ============================================================
-- 6. GOODS REJECTION LINE ITEMS
-- ============================================================
CREATE TABLE dbo.GoodsRejectionItems (
    RejectionItemId BIGINT PRIMARY KEY IDENTITY(1,1),
    RejectionId     INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    RejectedQty     DECIMAL(12,2) NOT NULL CHECK (RejectedQty > 0),
    UOM             VARCHAR(20)   NOT NULL,
    RejectionReason NVARCHAR(500),
    Remarks         NVARCHAR(500),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_GoodsRejectionItems_Rejection FOREIGN KEY (RejectionId) REFERENCES dbo.GoodsRejectionNotes(RejectionId),
    CONSTRAINT FK_GoodsRejectionItems_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId)
);
GO

CREATE INDEX IX_GoodsRejectionItems_RejId ON dbo.GoodsRejectionItems(RejectionId);
GO

-- ============================================================
-- 7. Add QA roles to Users check constraint
-- ============================================================
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
           'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk')
);
GO

PRINT 'Migration 002 complete — QA, Rejection, Batch No modules added.';
GO
