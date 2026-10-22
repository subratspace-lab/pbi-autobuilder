import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Cell, ScriptConnection, SqlConnection, TransformScript } from '../../../shared/types.js';
import type { RawTable } from './ingest.js';

// SQL Server access through Windows PowerShell's built-in .NET SqlClient: it
// supports Windows sign-in (Integrated Security) and SQL logins without any
// native Node driver. Only read-only queries (SELECT / WITH) are ever run.

// ---------------------------------------------------------------------------
// Connection details inside scripts
// ---------------------------------------------------------------------------

const stripBrackets = (s: string) => s.replace(/[[\]"`]/g, '').trim();

export function detectConnection(script: TransformScript): ScriptConnection {
  const text = script.text;
  const out: ScriptConnection = { hasPassword: false, tables: [], files: [], evidence: [] };
  const set = (key: 'server' | 'database' | 'user', value: string | undefined, where: string) => {
    const v = value && stripBrackets(value);
    if (v && !out[key]) {
      out[key] = v;
      out.evidence.push(`${key}: ${v} (${where})`);
    }
  };

  // Connection strings (in comments, Python strings, config notes)
  const cs = (k: string) => text.match(new RegExp(`(?:^|[;"'\\s])${k}\\s*=\\s*([^;"'\\n]+)`, 'i'))?.[1];
  set('server', cs('Server') ?? cs('Data Source') ?? cs('Address'), 'connection string');
  set('database', cs('Database') ?? cs('Initial Catalog'), 'connection string');
  set('user', cs('UID') ?? cs('User ID') ?? cs('User'), 'connection string');
  if (/\b(PWD|Password)\s*=\s*[^;"'\s]+/i.test(text)) out.hasPassword = true;
  if (/(Trusted_Connection|Integrated Security)\s*=\s*(yes|true|sspi)/i.test(text)) out.auth = 'windows';

  // SQLAlchemy URL: mssql+pyodbc://user:pass@host[:port]/db?driver=...
  const url = text.match(/mssql\+\w+:\/\/(?:([^:@/\s'"]*)(?::([^@/\s'"]*))?@)?([^/\s'"?@]+)\/([^?\s'"]+)/i);
  if (url) {
    set('user', url[1] ? decodeURIComponent(url[1]) : undefined, 'connection URL');
    if (url[2]) out.hasPassword = true;
    set('server', decodeURIComponent(url[3]), 'connection URL');
    set('database', decodeURIComponent(url[4]), 'connection URL');
    if (!url[1] && /trusted_connection=yes/i.test(text)) out.auth = 'windows';
  }

  // Python keyword arguments: pyodbc.connect(server="…", database="…")
  set('server', text.match(/\bserver\s*=\s*["']([^"']+)["']/i)?.[1], 'script argument');
  set('database', text.match(/\bdatabase\s*=\s*["']([^"']+)["']/i)?.[1], 'script argument');

  // Comments such as "-- Server: SQLPROD01" / "Database: SalesDB"
  set('server', text.match(/(?:--|#|\/\*|\*)\s*server(?:\s*name)?\s*:\s*([^\s*]+)/i)?.[1], 'comment');
  set('database', text.match(/(?:--|#|\/\*|\*)\s*database(?:\s*name)?\s*:\s*([^\s*]+)/i)?.[1], 'comment');

  if (script.language === 'sql') {
    const sql = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    set('database', sql.match(/^\s*USE\s+(\[[^\]]+\]|\w+)/im)?.[1], 'USE statement');
    // Files loaded by the script itself: BULK INSERT … FROM 'C:\…', OPENROWSET(BULK 'C:\…')
    for (const m of sql.matchAll(/\b(?:BULK\s+INSERT\s+[\w.[\]]+\s+FROM|OPENROWSET\s*\(\s*BULK)\s+N?'([^']+\.(?:csv|txt|tsv|xlsx|xls))'/gi)) out.files.push(m[1]);
    addSqlTables(sql, out);
  } else {
    for (const m of text.matchAll(/read_sql(?:_query)?\(\s*(?:f?["']{1,3})([\s\S]*?)["']{1,3}/g)) addSqlTables(m[1], out);
    for (const m of text.matchAll(/read_sql_table\(\s*["']([^"']+)["'](?:\s*,[^)]*schema\s*=\s*["']([^"']+)["'])?/g)) {
      const t = m[2] ? `${m[2]}.${m[1]}` : m[1];
      if (!out.tables.includes(t)) out.tables.push(t);
    }
    out.files.push(...pythonFilePaths(text));
  }
  if (out.user && !out.auth) out.auth = 'sql';
  out.files = [...new Set(out.files)];
  return out;
}

/** The password written in a script's connection string / URL — used only to connect, never stored or sent to the browser. */
export function scriptPassword(script: TransformScript): string | undefined {
  const t = script.text;
  const cs = t.match(/(?:^|[;"'\s])(?:PWD|Password)\s*=\s*([^;"'\n]+)/i)?.[1];
  if (cs) return cs.trim();
  const url = t.match(/mssql\+\w+:\/\/[^:@/\s'"]+:([^@/\s'"]*)@/i)?.[1];
  if (url) return decodeURIComponent(url);
  return t.match(/\bpassword\s*=\s*["']([^"']+)["']/i)?.[1];
}

/** Data files a pandas script reads, resolving simple folder variables (BASE = r"C:\data"; BASE / "sales.csv"). */
function pythonFilePaths(text: string): string[] {
  const strings = new Map<string, string>();
  const str = String.raw`(?:r|R|f)?["']([^"'\n]+)["']`;
  for (const m of text.matchAll(new RegExp(String.raw`^\s*(\w+)\s*=\s*(?:Path\(\s*)?${str}\s*\)?\s*$`, 'gm'))) strings.set(m[1], m[2]);
  // BASE / "file", os.path.join(BASE, "file"), Path(BASE, "file")
  for (const m of text.matchAll(new RegExp(String.raw`^\s*(\w+)\s*=\s*(?:Path\()?\s*(\w+)\s*\)?\s*(?:/|,)\s*${str}\s*\)?\s*$`, 'gm'))) {
    const base = strings.get(m[2]);
    if (base) strings.set(m[1], `${base.replace(/[\\/]+$/, '')}\\${m[3]}`);
  }
  for (const m of text.matchAll(new RegExp(String.raw`^\s*(\w+)\s*=\s*os\.path\.join\(\s*(\w+|${str})\s*,\s*${str}\s*\)`, 'gm'))) {
    const base = strings.get(m[2]) ?? m[3];
    if (base) strings.set(m[1], `${base.replace(/[\\/]+$/, '')}\\${m[4]}`);
  }
  const files: string[] = [];
  const isData = (p: string) => /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i.test(p);
  for (const m of text.matchAll(/read_(?:csv|excel|table)\(\s*([^,)]+)/g)) {
    const arg = m[1].trim();
    const lit = arg.match(new RegExp(`^(?:Path\\()?${str}`))?.[1];
    const p = lit ?? strings.get(arg.replace(/^Path\(|\)$/g, ''));
    if (p && isData(p)) files.push(p);
  }
  return files;
}

/** Tables read by FROM / JOIN, excluding CTEs and objects the script creates itself. */
function addSqlTables(sql: string, out: ScriptConnection) {
  const cte = new Set([...sql.matchAll(/(?:\bWITH|,)\s*(\[?\w+\]?)\s+AS\s*\(/gi)].map((m) => stripBrackets(m[1]).toLowerCase()));
  const created = new Set(
    [...sql.matchAll(/\b(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?(?:VIEW|TABLE)\s+([\w.[\]]+)/gi)].map((m) => stripBrackets(m[1]).toLowerCase()),
  );
  const ident = '(?:\\[[^\\]]+\\]|\\w+)';
  for (const m of sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+(${ident}(?:\\s*\\.\\s*${ident}){0,3})`, 'gi'))) {
    const parts = m[1].split('.').map((p) => stripBrackets(p));
    const name = parts.join('.');
    const lower = name.toLowerCase();
    if (cte.has(lower) || created.has(lower) || /^(select|values|openjson|string_split)$/i.test(parts[0])) continue;
    // 4-part: server.database.schema.table · 3-part: database.schema.table
    if (parts.length === 4) {
      if (!out.server) {
        out.server = parts[0];
        out.evidence.push(`server: ${parts[0]} (table name ${name})`);
      }
      if (!out.database) out.database = parts[1];
    } else if (parts.length === 3 && !out.database) {
      out.database = parts[0];
      out.evidence.push(`database: ${parts[0]} (table name ${name})`);
    }
    const table = parts.slice(-2).join('.');
    if (!out.tables.includes(table)) out.tables.push(table);
  }
}

// ---------------------------------------------------------------------------
// Running queries
// ---------------------------------------------------------------------------

/** Only read-only statements may be run. */
export function assertReadOnly(query: string) {
  const q = query.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(q)) throw new Error('Only SELECT queries (optionally starting with WITH) can be run');
  if (/;\s*\S/.test(q.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error('Run one query at a time (remove the extra statements after ";")');
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|into)\b/i.test(q.replace(/'(?:[^']|'')*'/g, "''"))) {
    throw new Error('The query must only read data (no INSERT / UPDATE / DELETE / DROP / EXEC / SELECT INTO)');
  }
}

/** [schema].[table] from "schema.table", "table" or bracketed names. */
export function quoteTable(name: string): string {
  const parts = name.split('.').map((p) => stripBrackets(p));
  if (!parts.length || parts.length > 3 || parts.some((p) => !p || /[\]\r\n]/.test(p))) throw new Error(`Invalid table name: ${name}`);
  return parts.map((p) => `[${p}]`).join('.');
}

export function connectionString(c: SqlConnection, password?: string) {
  const esc = (v: string) => (/[;'"=]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const parts = [`Server=${esc(c.server)}`, `Database=${esc(c.database)}`, 'TrustServerCertificate=True', 'Connect Timeout=15', 'Application Name=PBI AutoBuilder'];
  if (c.auth === 'windows') parts.push('Integrated Security=True');
  else {
    if (!c.user) throw new Error('Enter the SQL login user name');
    parts.push(`User ID=${esc(c.user)}`, `Password=${esc(password ?? '')}`);
  }
  return parts.join(';');
}

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$cn = New-Object System.Data.SqlClient.SqlConnection $env:PBI_CS
$cn.Open()
$cmd = $cn.CreateCommand()
$cmd.CommandText = $env:PBI_Q
$cmd.CommandTimeout = 600
$r = $cmd.ExecuteReader()
$w = New-Object System.IO.StreamWriter($env:PBI_OUT, $false, (New-Object System.Text.UTF8Encoding($false)))
$enc = { param($s) [System.Web.HttpUtility]::JavaScriptStringEncode([string]$s, $true) }
$names = @(); $types = @()
for ($i = 0; $i -lt $r.FieldCount; $i++) { $names += (& $enc $r.GetName($i)); $types += (& $enc $r.GetFieldType($i).Name) }
$w.WriteLine('{"headers":[' + ($names -join ',') + '],"types":[' + ($types -join ',') + ']}')
$max = [int]$env:PBI_MAX; $n = 0
$vals = New-Object object[] $r.FieldCount
while ($n -lt $max -and $r.Read()) {
  [void]$r.GetValues($vals)
  $parts = New-Object string[] $vals.Length
  for ($i = 0; $i -lt $vals.Length; $i++) {
    $v = $vals[$i]
    if ($v -is [System.DBNull]) { $parts[$i] = 'null' }
    elseif ($v -is [bool]) { $parts[$i] = $(if ($v) { 'true' } else { 'false' }) }
    elseif ($v -is [datetime]) { $parts[$i] = '"' + $(if ($v.TimeOfDay.Ticks -eq 0) { $v.ToString('yyyy-MM-dd', $inv) } else { $v.ToString('yyyy-MM-ddTHH:mm:ss', $inv) }) + '"' }
    elseif ($v -is [datetimeoffset]) { $parts[$i] = '"' + $v.ToString('yyyy-MM-ddTHH:mm:ss', $inv) + '"' }
    elseif ($v -is [byte] -or $v -is [int16] -or $v -is [int32] -or $v -is [int64] -or $v -is [decimal] -or $v -is [double] -or $v -is [single]) {
      $d = [double]$v
      if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { $parts[$i] = 'null' } else { $parts[$i] = $d.ToString('R', $inv) }
    }
    elseif ($v -is [byte[]]) { $parts[$i] = 'null' }
    else { $parts[$i] = (& $enc ([string]$v)) }
  }
  $w.WriteLine('[' + ($parts -join ',') + ']')
  $n++
}
$more = $r.Read()
$w.Close(); $r.Close(); $cn.Close()
if ($more) { exit 3 }
`;

export interface QueryResult extends RawTable {
  types: string[];
  truncated: boolean;
}

/** Run a read-only query and return the rows (values typed like Power Query would see them). */
export function runQuery(conn: SqlConnection, query: string, password?: string, maxRows = 1_000_000): Promise<QueryResult> {
  assertReadOnly(query);
  if (process.platform !== 'win32') return Promise.reject(new Error('SQL Server import currently needs Windows (it uses the built-in Windows SQL client)'));
  const outFile = path.join(os.tmpdir(), `pbi-sql-${crypto.randomUUID()}.jsonl`);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      env: { ...process.env, PBI_CS: connectionString(conn, password), PBI_Q: query, PBI_OUT: outFile, PBI_MAX: String(maxRows) },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        if (code !== 0 && code !== 3) {
          // PowerShell error records are verbose; keep the message line.
          const msg = stderr.match(/Exception calling "\w+" with "\d+" argument\(s\): "([\s\S]*?)"\s*(?:\r?\n|At line)/)?.[1] ?? stderr.split(/\r?\n/).find((l) => l.trim()) ?? `exit code ${code}`;
          throw new Error(friendlySqlError(msg.trim()));
        }
        const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
        const meta = JSON.parse(lines[0]) as { headers: string[]; types: string[] };
        const rows = lines.slice(1).map((l) => JSON.parse(l) as Cell[]);
        resolve({ headers: uniqueHeaders(meta.headers), types: meta.types, rows, truncated: code === 3 });
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(outFile, { force: true });
      }
    });
    child.stdin.end(PS_SCRIPT);
  });
}

function uniqueHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() || `Column${i + 1}`;
    const n = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), n + 1);
    return n ? `${base}_${n}` : base;
  });
}

function friendlySqlError(raw: string) {
  const msg = raw.replace(/\s+/g, ' ').trim();
  if (/network-related|instance-specific|could not open a connection|server was not found/i.test(msg)) {
    return `Could not reach the SQL Server. Check the server name (e.g. localhost\\SQLEXPRESS or SERVER01), that the server is running, and that remote/TCP connections are allowed. (${msg})`;
  }
  if (/login failed/i.test(msg)) return `Login failed — check the user name and password, or use Windows sign-in. (${msg})`;
  if (/cannot open database/i.test(msg)) return `The database name is wrong or this login has no access to it. (${msg})`;
  if (/invalid object name/i.test(msg)) return `Table or view not found — check the schema and name (e.g. dbo.Stg_Sales). (${msg})`;
  return msg;
}

// ---------------------------------------------------------------------------
// Snapshots (local copy used for profiling, previews and checks)
// ---------------------------------------------------------------------------

export function writeSnapshot(file: string, data: QueryResult) {
  fs.writeFileSync(file, JSON.stringify({ headers: data.headers, types: data.types, rows: data.rows }));
}

export function readSnapshot(file: string): RawTable {
  const d = JSON.parse(fs.readFileSync(file, 'utf8')) as { headers: string[]; rows: Cell[][] };
  return { headers: d.headers, rows: d.rows };
}

/** Friendly Power BI query name from "dbo.Stg_Sales" → "Stg Sales". */
export function tableDisplayName(table: string) {
  const last = stripBrackets(table.split('.').pop() ?? table);
  return last.replace(/^(stg|tbl|vw|dim|fact|fct)_/i, '').replace(/_/g, ' ').trim() || last;
}
