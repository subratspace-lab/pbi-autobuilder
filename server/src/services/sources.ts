import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, SqlConnection, TransformScript } from '../../../shared/types.js';
import { dataDir } from './store.js';
import { describeDataFile, isDataFile } from './ingest.js';
import { detectConnection, quoteTable, runQuery, scriptPassword, tableDisplayName, writeSnapshot } from './sqlserver.js';

// Loading data from where a script says it lives: a SQL Server or a file path.

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]|^\\\\|^\//.test(p);

/** Copy a data file from a local path into the project and add its tables. */
export function importLocalFile(p: Project, filePath: string): string[] {
  const src = path.resolve(filePath.trim().replace(/^["']|["']$/g, ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`File not found: ${src}`);
  const name = path.basename(src);
  if (!isDataFile(name)) throw new Error(`${name} is not a CSV / Excel file`);
  const target = path.join(dataDir(p.id), name);
  fs.copyFileSync(src, target);
  const kept = p.tables.filter((t) => t.file !== name);
  const added = describeDataFile(target, kept);
  if (!added.length) throw new Error(`${name}: no data found`);
  p.tables = [...kept, ...added];
  return added.map((t) => t.name);
}

/** Run a read-only query (or SELECT * FROM a table) on SQL Server and add the result as a table. */
export async function importSqlQuery(
  p: Project,
  conn: SqlConnection,
  password: string | undefined,
  item: { table?: string; query?: string; name?: string },
): Promise<{ name: string; rows: number; truncated: boolean }> {
  const query = item.query?.trim() || `SELECT * FROM ${quoteTable(item.table ?? '')}`;
  const res = await runQuery(conn, query, password);
  const base = (item.name?.trim() || (item.table ? tableDisplayName(item.table) : 'SQL Query')).replace(/[^\w ()-]/g, ' ').replace(/\s+/g, ' ').trim() || 'SQL Query';
  // Re-importing the same query replaces its table.
  const existing = p.tables.find((t) => t.kind === 'sql' && t.sql?.query === query && t.sql.server === conn.server && t.sql.database === conn.database);
  const taken = new Set(p.tables.filter((t) => t !== existing).map((t) => t.name.toLowerCase()));
  let name = existing?.name ?? base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  const file = existing?.file ?? `sql_${name.replace(/\W+/g, '_')}_${Date.now().toString(36)}.json`;
  writeSnapshot(path.join(dataDir(p.id), file), res);
  const table = {
    name,
    file,
    kind: 'sql' as const,
    rowCount: res.rows.length,
    headers: res.headers,
    sql: { server: conn.server, database: conn.database, auth: conn.auth, user: conn.user, query, fetchedAt: new Date().toISOString(), truncated: res.truncated || undefined },
  };
  p.tables = existing ? p.tables.map((t) => (t === existing ? table : t)) : [...p.tables, table];
  return { name, rows: res.rows.length, truncated: res.truncated };
}

/** Same-named files in the usual folders, offered as suggestions for a relative path like "sales.csv". */
export function findCandidates(fileName: string): string[] {
  const home = os.homedir();
  const roots = ['Downloads', 'Desktop', 'Documents', 'OneDrive\\Desktop', 'OneDrive\\Documents'].map((d) => path.join(home, d));
  const target = path.basename(fileName).toLowerCase();
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= 5 || depth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === target) found.push(full);
      else if (e.isDirectory()) walk(full, depth - 1);
    }
  };
  for (const r of roots) walk(r, 2);
  return [...new Set(found)];
}

export interface AutoLoadResult {
  loaded: string[];
  notes: string[];
}

/**
 * When a script fully describes where its data is, load it straight away:
 *  - SQL Server: server + database (+ Windows sign-in, or a login with password) and source tables
 *  - files: absolute paths that exist on this PC
 * Anything incomplete is reported so the UI can ask for just the missing part.
 */
export async function autoLoadFromScript(p: Project, script: TransformScript): Promise<AutoLoadResult> {
  const out: AutoLoadResult = { loaded: [], notes: [] };
  const conn = detectConnection(script);

  for (const f of conn.files) {
    if (!isAbsolute(f)) {
      out.notes.push(`${script.fileName} reads "${f}" but gives no folder — enter its full path (or upload it) to load it.`);
      continue;
    }
    if (!fs.existsSync(f)) {
      out.notes.push(`${script.fileName} reads ${f}, but that file does not exist on this PC.`);
      continue;
    }
    try {
      for (const t of importLocalFile(p, f)) out.loaded.push(`${t} (from ${f})`);
    } catch (e) {
      out.notes.push(`${f}: ${(e as Error).message}`);
    }
  }

  if (conn.tables.length) {
    const password = scriptPassword(script);
    const auth = conn.auth ?? (conn.user ? 'sql' : 'windows');
    const missing = [!conn.server && 'server name', !conn.database && 'database name', auth === 'sql' && !password && 'password'].filter(Boolean);
    if (missing.length) {
      out.notes.push(`${script.fileName} reads ${conn.tables.join(', ')} from SQL Server — add the ${missing.join(' and ')} to connect (Upload page → “Connect to SQL Server”).`);
    } else {
      const c: SqlConnection = { server: conn.server!, database: conn.database!, auth, user: conn.user };
      for (const table of conn.tables) {
        try {
          const r = await importSqlQuery(p, c, password, { table });
          out.loaded.push(`${r.name} (${r.rows.toLocaleString()} rows from ${c.server}/${c.database} ${table})${r.truncated ? ' — first 1,000,000 rows' : ''}`);
        } catch (e) {
          out.notes.push(`Could not load ${table} from ${c.server}/${c.database}: ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}
