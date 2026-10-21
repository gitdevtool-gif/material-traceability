-- Migration 009: Add Approval Tokens table for email-based Ops Manager approval
-- Tokens are single-use, time-limited, and allow approve/reject without login
-- ============================================================

IF OBJECT_ID('dbo.ApprovalTokens', 'U') IS NULL
CREATE TABLE dbo.ApprovalTokens (
    TokenId         INT PRIMARY KEY IDENTITY(1,1),
    Token           VARCHAR(100)  NOT NULL,
    EntryId         INT           NOT NULL,
    EntryNo         VARCHAR(20)   NOT NULL,
    Action          VARCHAR(10)   NULL,       -- NULL until used, then 'Approved' or 'Rejected'
    IsUsed          BIT           NOT NULL DEFAULT 0,
    ExpiresAt       DATETIME2     NOT NULL,
    UsedAt          DATETIME2     NULL,
    CreatedAt       DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_ApprovalTokens_Token UNIQUE (Token),
    CONSTRAINT FK_ApprovalTokens_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ApprovalTokens_Token' AND object_id = OBJECT_ID('dbo.ApprovalTokens'))
  CREATE INDEX IX_ApprovalTokens_Token ON dbo.ApprovalTokens(Token);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ApprovalTokens_EntryId' AND object_id = OBJECT_ID('dbo.ApprovalTokens'))
  CREATE INDEX IX_ApprovalTokens_EntryId ON dbo.ApprovalTokens(EntryId);
GO

PRINT 'Migration 009 complete — ApprovalTokens table created.';
GO
