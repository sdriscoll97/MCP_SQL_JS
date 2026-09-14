USE [master];
GO

SELECT
    name,
    type_desc,
    is_disabled,
    default_database_name,
    is_policy_checked,
    is_expiration_checked
FROM sys.sql_logins
WHERE name = N'claude_mcp_mke_ro';
GO

USE [D3TrendR];
GO

SELECT
    dp.name AS DatabaseUser,
    dp.type_desc,
    rp.name AS DatabaseRole
FROM sys.database_principals AS dp
LEFT JOIN sys.database_role_members AS drm
    ON drm.member_principal_id = dp.principal_id
LEFT JOIN sys.database_principals AS rp
    ON rp.principal_id = drm.role_principal_id
WHERE dp.name = N'claude_mcp_mke_ro';
GO