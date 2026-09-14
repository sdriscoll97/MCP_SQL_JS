USE [master];
GO

CREATE LOGIN [claude_mcp_mke_ro]
WITH
    PASSWORD = 'Sdd!19962026',
    CHECK_POLICY = ON,
    CHECK_EXPIRATION = OFF,
    DEFAULT_DATABASE = [D3TrendR];
GO

USE [D3TrendR];
GO

CREATE USER [claude_mcp_mke_ro]
FOR LOGIN [claude_mcp_mke_ro];
GO

ALTER ROLE [db_datareader]
ADD MEMBER [claude_mcp_mke_ro];
GO