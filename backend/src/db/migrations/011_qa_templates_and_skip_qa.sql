-- Migration 011: QA Test Templates + Skip QA support
-- 1. QA Test Templates: configurable test parameters per factory per material
-- 2. Add SkipQA flag to DeliveryEntries for materials that bypass QA
-- ============================================================

-- ──── 1. QA Test Templates table ────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'QATestTemplates')
CREATE TABLE dbo.QATestTemplates (
    TemplateId      INT PRIMARY KEY IDENTITY(1,1),
    LocationId      INT           NOT NULL,  -- Factory location
    MaterialId      INT           NOT NULL,
    TestName        NVARCHAR(100) NOT NULL,
    TestMethod      NVARCHAR(200),
    ExpectedValue   NVARCHAR(100),
    SortOrder       INT           DEFAULT 0,
    IsActive        BIT           DEFAULT 1,
    CreatedBy       INT           NOT NULL,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_QATestTemplates_Location FOREIGN KEY (LocationId) REFERENCES dbo.StockLocations(LocationId),
    CONSTRAINT FK_QATestTemplates_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId),
    CONSTRAINT FK_QATestTemplates_CreatedBy FOREIGN KEY (CreatedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_QATestTemplates_LocationMaterial ON dbo.QATestTemplates(LocationId, MaterialId);
GO

-- ──── 2. Add SkipQA flag to DeliveryEntries ────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.DeliveryEntries') AND name = 'SkipQA'
)
BEGIN
  ALTER TABLE dbo.DeliveryEntries ADD SkipQA BIT NOT NULL DEFAULT 0;
END
GO
