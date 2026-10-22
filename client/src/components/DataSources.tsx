import { useEffect, useState } from 'react';
import { Database, FolderOpen, PlugZap, Search } from 'lucide-react';
import type { Project, ScriptConnection, TransformScript } from '@shared/types';
import { api, type SqlForm } from '../api/client';
import { useStore } from '../store/projectStore';
import { Spinner } from './ui';

type Loaded = (res: { project: Project; loaded: string[]; warnings: string[] }) => void;

/** Connect to SQL Server and load tables or a query. Pre-filled from a script when available. */
export function SqlConnectForm({
  initial,
  scriptFile,
  hasPassword,
  onLoaded,
}: {
  initial?: Partial<ScriptConnection>;
  scriptFile?: string;
  hasPassword?: boolean;
  onLoaded: Loaded;
}) {
  const { project, run, busy, toast } = useStore();
  const [form, setForm] = useState<SqlForm>({
    server: initial?.server ?? '',
    database: initial?.database ?? '',
    auth: initial?.auth ?? (initial?.user ? 'sql' : 'windows'),
    user: initial?.user ?? '',
    password: '',
    scriptFile,
  });
  const [tables, setTables] = useState<string[]>(initial?.tables ?? []);
  const [available, setAvailable] = useState<{ name: string; view: boolean }[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (!project) return null;
  const set = (patch: Partial<SqlForm>) => setForm((f) => ({ ...f, ...patch }));

  const test = async () => {
    setStatus(null);
    const r = await run('sqlTest', () => api.sqlTest(project.id, form));
    if (r) setStatus({ ok: true, text: `Connected to ${r.server} / ${r.database} — ${r.version}` });
  };
  const browse = async () => {
    const r = await run('sqlTables', () => api.sqlTables(project.id, form));
    if (r) setAvailable(r.tables);
  };
  const load = async () => {
    const items = [...tables.map((t) => ({ table: t })), ...(query.trim() ? [{ query: query.trim(), name: 'SQL Query' }] : [])];
    const r = await run('sqlImport', () => api.sqlImport(project.id, { ...form, items }));
    if (r) {
      toast('success', `Loaded ${r.loaded.join(', ')}`, r.warnings);
      onLoaded(r);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <label className="label">Server</label>
          <input className="input font-mono text-xs" placeholder="localhost\SQLEXPRESS or SERVER01" value={form.server} onChange={(e) => set({ server: e.target.value })} />
        </div>
        <div>
          <label className="label">Database</label>
          <input className="input font-mono text-xs" placeholder="SalesDB" value={form.database} onChange={(e) => set({ database: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" className="accent-brand-600" checked={form.auth === 'windows'} onChange={() => set({ auth: 'windows' })} /> Windows sign-in
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" className="accent-brand-600" checked={form.auth === 'sql'} onChange={() => set({ auth: 'sql' })} /> SQL login
        </label>
      </div>
      {form.auth === 'sql' && (
        <div className="grid gap-2 md:grid-cols-2">
          <input className="input" placeholder="User name" value={form.user ?? ''} onChange={(e) => set({ user: e.target.value })} />
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder={hasPassword ? 'Leave empty to use the password in the script' : 'Password (used once, never saved)'}
            value={form.password ?? ''}
            onChange={(e) => set({ password: e.target.value })}
          />
        </div>
      )}
      <div>
        <label className="label">Tables to load</label>
        <div className="flex flex-wrap gap-1.5">
          {tables.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 font-mono text-xs text-brand-700">
              {t}
              <button className="text-brand-400 hover:text-brand-700" onClick={() => setTables(tables.filter((x) => x !== t))}>
                ×
              </button>
            </span>
          ))}
          {!tables.length && <span className="text-xs text-slate-400">none yet — browse the server or type a query</span>}
        </div>
        {available && (
          <select
            className="input mt-2 py-1 text-xs"
            value=""
            onChange={(e) => e.target.value && !tables.includes(e.target.value) && setTables([...tables, e.target.value])}
          >
            <option value="">Add a table or view from {form.database}…</option>
            {available.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.view ? ' (view)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-slate-500">…or run your own SELECT query</summary>
        <textarea className="input mt-2 h-24 font-mono text-xs" placeholder="SELECT … FROM dbo.Orders WHERE …" value={query} onChange={(e) => setQuery(e.target.value)} />
        <p className="mt-1 text-xs text-slate-400">Read-only: only SELECT / WITH queries are allowed.</p>
      </details>
      {status && <div className={`text-xs ${status.ok ? 'text-emerald-700' : 'text-red-600'}`}>{status.text}</div>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={busy.sqlTest || !form.server || !form.database} onClick={test}>
          {busy.sqlTest ? <Spinner /> : <PlugZap className="h-4 w-4" />} Test connection
        </button>
        <button className="btn-secondary" disabled={busy.sqlTables || !form.server || !form.database} onClick={browse}>
          {busy.sqlTables ? <Spinner /> : <Search className="h-4 w-4" />} Browse tables
        </button>
        <button className="btn-primary" disabled={busy.sqlImport || !form.server || !form.database || (!tables.length && !query.trim())} onClick={load}>
          {busy.sqlImport ? <Spinner /> : <Database className="h-4 w-4" />} Load data
        </button>
      </div>
      <p className="text-xs text-slate-400">
        The app runs the queries from this PC through Windows&apos; built-in SQL client. In the exported Power BI file the tables stay connected to this server, and Power BI asks
        for the login on the first refresh.
      </p>
    </div>
  );
}

/** Load a CSV / Excel file directly from a path on this PC. */
export function PathLoader({ initial, suggestions = [], onLoaded }: { initial?: string; suggestions?: string[]; onLoaded: Loaded }) {
  const { project, run, busy, toast } = useStore();
  const [value, setValue] = useState(initial ?? '');
  if (!project) return null;
  const load = async (p: string) => {
    const r = await run('importPath', () => api.importPath(project.id, p));
    if (r) {
      toast('success', `Loaded ${r.loaded.join(', ')}`, r.warnings);
      onLoaded(r);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input className="input font-mono text-xs" placeholder="C:\Data\sales.csv" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn-primary shrink-0" disabled={!value.trim() || busy.importPath} onClick={() => load(value)}>
          {busy.importPath ? <Spinner /> : <FolderOpen className="h-4 w-4" />} Load
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="text-xs text-slate-500">
          Found on this PC:{' '}
          {suggestions.map((s) => (
            <button key={s} className="mr-2 font-mono text-brand-600 underline" onClick={() => load(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What a script says about where its data lives, with the matching action. */
export function ScriptSource({ script, onLoaded }: { script: TransformScript; onLoaded: Loaded }) {
  const { project } = useStore();
  const [info, setInfo] = useState<{ connection: ScriptConnection; candidates: Record<string, string[]> } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (project) void api.scriptConnection(project.id, script.fileName).then(setInfo, () => setInfo(null));
  }, [project?.id, script.fileName, script.text]);
  if (!project || !info) return null;
  const c = info.connection;
  const relFiles = c.files.filter((f) => f in info.candidates);
  if (!c.tables.length && !relFiles.length) return null;
  const linked = Boolean(script.table);
  const fromServer = project.tables.some((t) => t.sql && c.tables.some((x) => t.sql!.query.toLowerCase().includes(x.split('.').pop()!.toLowerCase())));

  return (
    <div className="mt-2 w-full space-y-2 border-t border-slate-100 pt-2 text-xs">
      {c.tables.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-slate-600">
            <Database className="h-3.5 w-3.5 text-sky-600" />
            Reads <b className="font-mono">{c.tables.join(', ')}</b> from SQL Server
            {c.server ? (
              <span>
                on <b className="font-mono">{c.server}</b>
              </span>
            ) : (
              <span className="text-amber-600">(server not named in the script)</span>
            )}
            {c.database && (
              <span>
                · database <b className="font-mono">{c.database}</b>
              </span>
            )}
            <button className="btn-ghost px-2 py-0.5 text-xs text-brand-600" onClick={() => setOpen(!open)}>
              {open ? 'Hide' : fromServer ? 'Reload from server' : 'Connect & load'}
            </button>
          </div>
          {open && (
            <div className="mt-2">
              <SqlConnectForm initial={c} scriptFile={script.fileName} hasPassword={c.hasPassword} onLoaded={(r) => (setOpen(false), onLoaded(r))} />
            </div>
          )}
        </div>
      )}
      {!linked &&
        relFiles.map((f) => (
          <div key={f}>
            <div className="mb-1 flex items-center gap-2 text-slate-600">
              <FolderOpen className="h-3.5 w-3.5 text-amber-600" /> Reads <b className="font-mono">{f}</b> — where is it?
            </div>
            <PathLoader suggestions={info.candidates[f]} onLoaded={onLoaded} />
          </div>
        ))}
    </div>
  );
}
