/**
 * SQL Query Tools — MCP Server
 * Read-only MCP server for SQL Server databases.
 * Modified to support multiple plants (servers) via a single config.
 *
 * Author: --Pablon-- (https://github.com/negrip)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import sql from 'mssql';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const envLocal = path.join(__dirname, 'env.local');
if (fs.existsSync(envLocal)) {
  const txt = fs.readFileSync(envLocal, 'utf8');
  txt.split('\n').forEach(line => {
    const [k, ...vp] = line.split('=');
    if (!k || k.trim().startsWith('#')) return;
    const v = vp.join('=').trim();
    if (v && !process.env[k.trim()]) process.env[k.trim()] = v;
  });
}

// ---- Required environment variables validation ----
const REQUIRED_ENV = ['PLANT_SERVERS', 'SQL_DATABASE', 'SQL_USER', 'SQL_PASSWORD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Required environment variables not defined: ${missing.join(', ')}`);
  console.error('   Make sure you have a .env file with those variables. See env.example.');
  process.exit(1);
}

// ---- Plant server mapping ----
// Format: PLANT_SERVERS=plant1=SERVERNAME1,plant2=SERVERNAME2,plant3=SERVERNAME3
const PLANT_SERVERS = {};
(process.env.PLANT_SERVERS || '').split(',').forEach(pair => {
  const [name, srv] = pair.split('=').map(s => (s || '').trim());
  if (name && srv) PLANT_SERVERS[name.toLowerCase()] = srv;
});

if (Object.keys(PLANT_SERVERS).length === 0) {
  console.error('❌ No plants defined in PLANT_SERVERS. Format: plant1=SERVER1,plant2=SERVER2');
  process.exit(1);
}

const DEFAULT_PLANT = (process.env.DEFAULT_PLANT || Object.keys(PLANT_SERVERS)[0]).toLowerCase();

function resolvePlant(plantArg) {
  const plant = String(plantArg || DEFAULT_PLANT).toLowerCase();
  if (!PLANT_SERVERS[plant]) {
    throw new Error(`Unknown plant "${plant}". Available plants: ${Object.keys(PLANT_SERVERS).join(', ')}`);
  }
  return plant;
}

// ---- Configuration ----
const ALLOWED_TABLES_RAW = (process.env.ALLOWED_TABLES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isTableAllowed(fullName) {
  if (ALLOWED_TABLES_RAW.length === 0) return true;
  for (const pat of ALLOWED_TABLES_RAW) {
    if (pat.endsWith('*')) {
      const prefix = pat.slice(0, -1);
      if (fullName.startsWith(prefix)) return true;
    } else if (fullName === pat) {
      return true;
    }
  }
  return false;
}

const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
const QUERY_TIMEOUT = Number(process.env.SQL_QUERY_TIMEOUT || 30000);
const SCHEMA_CACHE_TTL = Number(process.env.SCHEMA_CACHE_TTL_MINUTES || 5) * 60 * 1000;

// ---- Audit log ----
const AUDIT_ENABLED = (process.env.AUDIT_LOG || 'false').toLowerCase() === 'true';
const AUDIT_DIR = path.resolve(__dirname, process.env.AUDIT_LOG_DIR || './logs');

function writeAuditLog(tool, target, result, durationMs) {
  if (!AUDIT_ENABLED) return;
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(AUDIT_DIR, `audit-${date}.log`);
    const ts = new Date().toISOString();
    const t = String(target).replace(/\s+/g, ' ').trim().slice(0, 100);
    const line = `[${ts}] ${tool} | ${t} | ${result}\n`;
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    console.error('⚠️ Audit log write failed:', e.message);
  }
}

// ---- Schema cache (one per plant) ----
const schemaCache = {}; // plant -> { text, time }

// ---- SQL Server config builder (per plant) ----
function buildSqlConfig(serverName) {
  return {
    server: serverName,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: (process.env.SQL_ENCRYPT || 'false').toLowerCase() === 'true',
      trustServerCertificate: (process.env.SQL_TRUST_SERVER_CERT || 'true').toLowerCase() === 'true',
      instanceName: process.env.SQL_INSTANCE || undefined
    },
    requestTimeout: QUERY_TIMEOUT,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };
}

console.error('Plants configured:', Object.keys(PLANT_SERVERS));
console.error('Default plant:', DEFAULT_PLANT);
console.error('Database:', process.env.SQL_DATABASE);
console.error('Audit log:', AUDIT_ENABLED);

// ---- Connection pools (one per plant, cached and reused) ----
const pools = {}; // plant -> ConnectionPool

async function getPool(plant) {
  if (!pools[plant]) {
    try {
      console.error(`Connecting to SQL Server for plant "${plant}" (${PLANT_SERVERS[plant]})...`);
      const config = buildSqlConfig(PLANT_SERVERS[plant]);
      pools[plant] = await new sql.ConnectionPool(config).connect();
      console.error(`✅ Connected to plant "${plant}"`);
    } catch (error) {
      console.error(`❌ Error connecting to plant "${plant}":`, error.message);
      throw error;
    }
  }
  return pools[plant];
}

// ---- Security guards ----
function onlySelectGuard(query) {
  const stripped = (query || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!stripped.startsWith('select')) {
    throw new Error('Only SELECT queries are allowed.');
  }

  const banned = [
    ' drop ', ' delete ', ' update ', ' insert ', ' alter ',
    ' truncate ', ' create ', ' exec ', ' execute ', ' waitfor ',
    'xp_', 'sp_'
  ];
  for (const b of banned) {
    if (stripped.includes(b)) {
      throw new Error(`Forbidden keyword in readonly query: ${b.trim()}`);
    }
  }

  if (stripped.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed.');
  }
}

function extractTableNames(query) {
  const clean = query.replace(/\s+/g, ' ');
  const tables = [];
  const patterns = [/\bfrom\s+([\w.\[\]]+)/gi, /\bjoin\s+([\w.\[\]]+)/gi];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(clean)) !== null) {
      tables.push(match[1].replace(/\[|\]/g, '').toLowerCase());
    }
  }
  return tables;
}

function injectTopIfMissing(query) {
  const q = query.trim();
  const low = q.toLowerCase();
  if (!low.startsWith('select')) return q;
  if (low.includes(' top ') || low.includes(' offset ') || low.includes(' fetch ')) return q;
  return 'SELECT TOP ' + MAX_ROWS + ' ' + q.slice(6).trim();
}

// ---- Database functions (all take plant as first argument) ----
async function describeSchemaSummary(plant) {
  const cached = schemaCache[plant];
  if (cached && (Date.now() - cached.time) < SCHEMA_CACHE_TTL) {
    console.error(`✅ Schema for "${plant}" served from cache`);
    return cached.text;
  }

  const pool = await getPool(plant);
  console.error(`Describing schema for plant "${plant}"...`);

  const result = await pool.request().query(`
    SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [table], TABLE_TYPE AS [type]
    FROM INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_TYPE, TABLE_SCHEMA, TABLE_NAME;
  `);

  const lines = [];
  for (const row of result.recordset) {
    const full = `${row.schema}.${row.table}`;
    if (!isTableAllowed(full.toLowerCase()) && !isTableAllowed(row.table.toLowerCase())) continue;

    try {
      const cols = await pool.request()
        .input('ts', sql.NVarChar, row.schema)
        .input('tn', sql.NVarChar, row.table)
        .query(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@ts AND TABLE_NAME=@tn;`);
      const type = row.type === 'VIEW' ? 'view' : 'table';
      lines.push(`- ${full} (${type}, ${cols.recordset[0].cnt} columns)`);
    } catch {
      lines.push(`- ${full} (error counting columns)`);
    }
  }

  const text = lines.join('\n');
  schemaCache[plant] = { text, time: Date.now() };
  console.error(`✅ Schema for "${plant}": ${lines.length} objects listed — cached for ${process.env.SCHEMA_CACHE_TTL_MINUTES || 5} min`);
  return text;
}

async function describeTableDetail(plant, table) {
  const pool = await getPool(plant);
  const [schema, name] = table.includes('.') ? table.split('.') : ['dbo', table];
  const result = await pool.request()
    .input('ts', sql.NVarChar, schema)
    .input('tn', sql.NVarChar, name)
    .query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=@ts AND TABLE_NAME=@tn
      ORDER BY ORDINAL_POSITION;
    `);

  if (result.recordset.length === 0) {
    return `Table ${schema}.${name} not found or has no columns (plant: ${plant}).`;
  }

  const def = result.recordset.map(c => {
    const len = c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : '';
    const nullable = c.IS_NULLABLE === 'YES' ? ' NULL' : ' NOT NULL';
    return `  ${c.COLUMN_NAME} ${c.DATA_TYPE}${len}${nullable}`;
  }).join('\n');

  return `Table ${schema}.${name} (plant: ${plant}):\n${def}`;
}

async function sampleTableData(plant, table) {
  const pool = await getPool(plant);
  const [schema, name] = table.includes('.') ? table.split('.') : ['dbo', table];
  const result = await pool.request().query(
    `SELECT TOP 5 * FROM [${schema}].[${name}]`
  );
  if (result.recordset.length === 0) return `Table ${schema}.${name} is empty (plant: ${plant}).`;
  return JSON.stringify(result.recordset, null, 2);
}

async function testConnection(plant) {
  try {
    const pool = await getPool(plant);
    const result = await pool.request()
      .query('SELECT 1 as test, GETDATE() as current_datetime, @@VERSION as version');
    return { success: true, plant, server: PLANT_SERVERS[plant], data: result.recordset[0] };
  } catch (error) {
    return { success: false, plant, server: PLANT_SERVERS[plant], error: error.message };
  }
}

// ---- MCP Server ----
const server = new Server(
  { name: 'sql-query-tools', version: '1.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const plantDesc = `Plant to connect to. Available: ${Object.keys(PLANT_SERVERS).join(', ')}. Defaults to "${DEFAULT_PLANT}" if omitted.`;
  return {
    tools: [
      {
        name: 'db_test_connection',
        description: 'Tests the connection to SQL Server and returns basic server information. Use this first to verify the server is reachable before running other tools.',
        inputSchema: {
          type: 'object',
          properties: { plant: { type: 'string', description: plantDesc } }
        }
      },
      {
        name: 'db_describe_schema',
        description: 'Returns all available tables and views with their column count. Use this first to understand what data is available before writing queries. Results are cached per plant to avoid repeated database calls.',
        inputSchema: {
          type: 'object',
          properties: { plant: { type: 'string', description: plantDesc } }
        }
      },
      {
        name: 'db_describe_table',
        description: 'Returns full column details (name, data type, nullable) for a specific table or view. Use this when you need to know exact column names before writing a query.',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table or view name. Example: dbo.MyTable' },
            plant: { type: 'string', description: plantDesc }
          },
          required: ['table']
        }
      },
      {
        name: 'db_sample_data',
        description: 'Returns 5 sample rows from a table or view. Use this to understand the actual data format, values and patterns before writing a more specific query.',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table or view name. Example: dbo.MyTable' },
            plant: { type: 'string', description: plantDesc }
          },
          required: ['table']
        }
      },
      {
        name: 'db_run_readonly',
        description: 'Executes a SELECT query on SQL Server. Only read operations are allowed — write operations are blocked. TOP is automatically injected if no row limit is present. Use db_describe_schema and db_describe_table first if you are unsure about table or column names.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SELECT SQL query to execute.' },
            plant: { type: 'string', description: plantDesc }
          },
          required: ['query']
        }
      },
      {
        name: 'db_list_databases',
        description: 'Returns the currently connected database name and status.',
        inputSchema: {
          type: 'object',
          properties: { plant: { type: 'string', description: plantDesc } }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const start = Date.now();

  let plant;
  try {
    plant = resolvePlant(args.plant);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
  }

  const tag = (t) => `[${plant}] ${t}`;

  try {
    console.error(`🛠️ Tool: ${name} (plant: ${plant})`);

    if (name === 'db_test_connection') {
      const result = await testConnection(plant);
      writeAuditLog(name, tag(PLANT_SERVERS[plant]), result.success ? 'ok' : 'error', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'db_describe_schema') {
      const text = await describeSchemaSummary(plant);
      writeAuditLog(name, tag(process.env.SQL_DATABASE), 'ok', Date.now() - start);
      return { content: [{ type: 'text', text: text || '(no allowed tables found)' }] };
    }

    if (name === 'db_describe_table') {
      const table = String(args.table || '').trim();
      if (!table) throw new Error('Parameter "table" is required.');
      if (!isTableAllowed(table.toLowerCase()) && !isTableAllowed(table.split('.').pop().toLowerCase())) {
        writeAuditLog(name, tag(table), 'BLOCKED: table not allowed', Date.now() - start);
        throw new Error(`Access to table not allowed: ${table}`);
      }
      const detail = await describeTableDetail(plant, table);
      writeAuditLog(name, tag(table), 'ok', Date.now() - start);
      return { content: [{ type: 'text', text: detail }] };
    }

    if (name === 'db_sample_data') {
      const table = String(args.table || '').trim();
      if (!table) throw new Error('Parameter "table" is required.');
      if (!isTableAllowed(table.toLowerCase()) && !isTableAllowed(table.split('.').pop().toLowerCase())) {
        writeAuditLog(name, tag(table), 'BLOCKED: table not allowed', Date.now() - start);
        throw new Error(`Access to table not allowed: ${table}`);
      }
      const text = await sampleTableData(plant, table);
      writeAuditLog(name, tag(table), 'ok', Date.now() - start);
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'db_run_readonly') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('Parameter "query" is required.');
      console.error(`📝 Query [${plant}]: ${query}`);
      onlySelectGuard(query);
      if (ALLOWED_TABLES_RAW.length > 0) {
        const tables = extractTableNames(query);
        for (const t of tables) {
          if (!isTableAllowed(t)) {
            writeAuditLog(name, tag(query), `BLOCKED: table not allowed (${t})`, Date.now() - start);
            throw new Error(`Access to table not allowed: ${t}`);
          }
        }
      }
      const safe = injectTopIfMissing(query);
      const pool = await getPool(plant);
      const res = await pool.request().query(safe);
      writeAuditLog(name, tag(query), `ok | rows:${res.recordset.length} | ${Date.now() - start}ms`, Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify(res.recordset, null, 2) }] };
    }

    if (name === 'db_list_databases') {
      const pool = await getPool(plant);
      const result = await pool.request().query(`
        SELECT name, state_desc FROM sys.databases WHERE name = DB_NAME();
      `);
      writeAuditLog(name, tag(process.env.SQL_DATABASE), 'ok', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
    }

    if (name === 'audit_trail') {
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

  } catch (e) {
    console.error(`❌ Error in ${name}:`, e.message);
    writeAuditLog(name, tag(args.query || args.table || ''), `error: ${e.message}`, Date.now() - start);
    return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
  }
});

console.error('🚀 Starting MCP SQL server...');
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('✅ MCP server connected and ready');