USE [D3TrendR];
GO

EXECUTE AS LOGIN = 'claude_mcp_mke_ro';

SELECT
    SUSER_SNAME() AS EffectiveLogin,
    USER_NAME() AS EffectiveDatabaseUser,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONNECT') AS CanConnect,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS CanSelect,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS CanInsert,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS CanUpdate,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') AS CanDelete,
    HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'EXECUTE') AS CanExecute;

REVERT;
GO