import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Database, FileCode2, FileSpreadsheet, FileText, FolderOpen, RefreshCw, Save, Trash2, UploadCloud } from 'lucide-react';
import type { Cell } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { DataTable } from '../components/DataTable';
import { PageHeader, Spinner } from '../components/ui';
import { PathLoader, ScriptSource, SqlConnectForm } from '../components/DataSources';

function DropZone({ accept, label, hint, onFiles, busy, icon }: { accept: string; label: string; hint: string; onFiles: (f: File[]) => void; busy?: boolean; icon: React.ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      onClick={() => input.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
        over ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white hover:border-brand-500'
      }`}
    >
      <input ref={input} type="file" multiple accept={accept} className="hidden" onChange={(e) => e.target.files && onFiles([...e.target.files])} />
      <div className="mb-2 text-brand-600">{busy ? <Spinner className="h-8 w-8" /> : icon}</div>
      <div className="font-medium text-slate-800">{label}</div>
      <div className="mt-0.5 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

export function UploadPage() {
  const { project, setProject, run, busy, toast } = useStore();
  const navigate = useNavigate();
  const [brief, setBrief] = useState(project?.brief.text ?? '');
  const [preview, setPreview] = useState<{ table: string; headers: string[]; rows: Cell[][]; total: number } | null>(null);
  const [source, setSource] = useState<'sql' | 'path' | null>(null);

  useEffect(() => setBrief(project?.brief.text ?? ''), [project?.brief.text]);
  if (!project) return null;

  const upload = async (files: File[], kind: 'data' | 'brief' | 'script') => {
    const res = await run(kind, () => api.upload(project.id, files, kind));
    if (res) {
      setProject(res.project);
      if (res.warnings.length) toast('info', 'Upload notes', res.warnings);
      else toast('success', `${files.length} file(s) uploaded`);
    }
  };

  const showPreview = async (table: string) => {
    const res = await run('raw', () => api.raw(project.id, table));
    if (res) setPreview({ table, ...res });
  };

  const next = async () => {
    if (brief !== project.brief.text) await run('brief', async () => setProject(await api.patchProject(project.id, { brief: { text: brief } })));
    const p = await run('profile', () => api.profile(project.id));
    if (p) {
      setProject(p);
      navigate(`/p/${project.id}/profile`);
    }
  };

  return (
    <>
      <PageHeader step="Step 1" title="Upload raw data & the project brief" subtitle="CSV or Excel files (every sheet becomes a table). The brief tells the AI what the business needs: KPIs, visuals, slicers, DAX procedure." />

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 font-semibold text-slate-900">Raw data</h2>
          <DropZone
            accept=".csv,.txt,.tsv,.xlsx,.xlsm,.xls,.sql,.py,.ipynb"
            label="Drop CSV / Excel files here"
            hint="or click to browse · up to 500 MB each · .sql / .py scripts are recognised too"
            icon={<FileSpreadsheet className="h-8 w-8" />}
            busy={busy.data}
            onFiles={(f) => upload(f, 'data')}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={`btn-secondary py-1.5 text-xs ${source === 'sql' ? 'border-brand-500 text-brand-700' : ''}`} onClick={() => setSource(source === 'sql' ? null : 'sql')}>
              <Database className="h-3.5 w-3.5" /> Connect to SQL Server
            </button>
            <button className={`btn-secondary py-1.5 text-xs ${source === 'path' ? 'border-brand-500 text-brand-700' : ''}`} onClick={() => setSource(source === 'path' ? null : 'path')}>
              <FolderOpen className="h-3.5 w-3.5" /> Load from a file path
            </button>
          </div>
          {source === 'sql' && (
            <div className="mt-2">
              <SqlConnectForm onLoaded={(r) => (setProject(r.project), setSource(null))} />
            </div>
          )}
          {source === 'path' && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <PathLoader onLoaded={(r) => (setProject(r.project), setSource(null))} />
            </div>
          )}
          <div className="mt-4 space-y-2">
            {project.tables.map((t) => (
              <div key={t.name} className="card flex items-center gap-3 p-3">
                <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />
                <button className="min-w-0 flex-1 text-left" onClick={() => showPreview(t.name)}>
                  <div className="truncate font-medium text-slate-900">{t.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {t.sql ? `SQL Server · ${t.sql.server} / ${t.sql.database}` : t.file}
                    {t.sheet ? ` › ${t.sheet}` : ''} · {t.rowCount.toLocaleString()} rows · {t.headers.length} columns
                    {t.sql ? ` · loaded ${new Date(t.sql.fetchedAt).toLocaleString()}` : ''}
                  </div>
                </button>
                {t.sql && (
                  <button
                    className="btn-ghost p-2"
                    title="Reload from SQL Server"
                    disabled={busy.refreshTable}
                    onClick={async () => {
                      const password = t.sql!.auth === 'sql' ? (window.prompt(`Password for ${t.sql!.user} (leave empty to use the one in the script)`) ?? undefined) : undefined;
                      const r = await run('refreshTable', () => api.refreshTable(project.id, t.name, password || undefined));
                      if (r) {
                        setProject(r.project);
                        toast('success', `Reloaded ${r.loaded.join(', ')}`, r.warnings);
                      }
                    }}
                  >
                    {busy.refreshTable ? <Spinner /> : <RefreshCw className="h-4 w-4 text-sky-600" />}
                  </button>
                )}
                <button
                  className="btn-ghost p-2"
                  title="Remove table"
                  onClick={async () => {
                    if (!confirm(`Remove table "${t.name}"?`)) return;
                    const p = await run('del', () => api.deleteTable(project.id, t.name));
                    if (p) setProject(p);
                    if (preview?.table === t.name) setPreview(null);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 font-semibold text-slate-900">Project brief</h2>
          <DropZone
            accept=".pdf,.docx,.md,.txt"
            label="Drop the brief (PDF, Word, Markdown, text)"
            hint="the text is extracted and appended below"
            icon={<FileText className="h-8 w-8" />}
            busy={busy.brief}
            onFiles={(f) => upload(f, 'brief')}
          />
          <textarea
            className="input mt-3 h-56 font-mono text-xs"
            placeholder="…or paste the requirements: business problem, KPIs, required charts, slicers, DAX procedure"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          {brief !== project.brief.text && (
            <button
              className="btn-secondary mt-2"
              onClick={async () => {
                const p = await run('brief', () => api.patchProject(project.id, { brief: { text: brief } }));
                if (p) {
                  setProject(p);
                  toast('success', 'Brief saved');
                }
              }}
            >
              <Save className="h-4 w-4" /> Save brief
            </button>
          )}
        </section>
      </div>

      <section className="mt-8">
        <h2 className="mb-1 font-semibold text-slate-900">
          Transformation scripts <span className="font-normal text-slate-500">(optional)</span>
        </h2>
        <p className="mb-2 text-sm text-slate-500">
          Already have the cleaning logic in SQL or Python (pandas)? Upload the script — its trims, type conversions, filters, de-duplication, fills and calculated columns are
          translated into Power Query steps on the Clean page. Scripts are read, never run.
        </p>
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <DropZone
            accept=".sql,.py,.ipynb"
            label="Drop .sql / .py / .ipynb files"
            hint="SQL Server views & queries · pandas scripts · Jupyter notebooks"
            icon={<FileCode2 className="h-8 w-8" />}
            busy={busy.script}
            onFiles={(f) => upload(f, 'script')}
          />
          <div className="space-y-2">
            {!(project.scripts ?? []).length && <div className="card p-4 text-sm text-slate-400">No scripts uploaded.</div>}
            {(project.scripts ?? []).map((s) => (
              <div key={s.fileName} className="card flex flex-wrap items-center gap-3 p-3">
                <FileCode2 className={`h-5 w-5 shrink-0 ${s.language === 'sql' ? 'text-sky-600' : 'text-amber-600'}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900">{s.fileName}</div>
                  <div className="text-xs text-slate-500">
                    {s.language === 'sql' ? 'SQL' : 'Python'} · {s.text.split('\n').length} lines
                  </div>
                  {!s.table && (
                    <div className="mt-0.5 text-xs font-medium text-amber-600">
                      {project.tables.length ? 'No table matched its columns — choose the table it cleans →' : 'Waiting for data — upload the file this script cleans above'}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-500">
                  applies to
                  <select
                    className="input w-44 py-1 text-xs"
                    value={s.table ?? ''}
                    onChange={async (e) => {
                      const p = await run('scriptTable', () => api.setScriptTable(project.id, s.fileName, e.target.value));
                      if (p) setProject(p);
                    }}
                  >
                    <option value="">— choose table —</option>
                    {project.tables.map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                  </select>
                </label>
                <ScriptSource
                  script={s}
                  onLoaded={(r) => {
                    setProject(r.project);
                  }}
                />
                <button
                  className="btn-ghost p-2"
                  title="Remove script"
                  onClick={async () => {
                    const p = await run('delScript', () => api.deleteScript(project.id, s.fileName));
                    if (p) setProject(p);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {preview && (
        <section className="mt-8">
          <h2 className="mb-2 font-semibold text-slate-900">
            Raw preview — {preview.table} <span className="font-normal text-slate-500">(first {preview.rows.length} of {preview.total.toLocaleString()} rows)</span>
          </h2>
          <DataTable headers={preview.headers} rows={preview.rows} />
        </section>
      )}

      <div className="mt-8 flex items-center justify-between gap-3">
        <Link to="/" className="btn-secondary">
          <ArrowLeft className="h-4 w-4" /> All projects
        </Link>
        <button className="btn-primary" disabled={!project.tables.length || busy.profile} onClick={next}>
          {busy.profile ? <Spinner /> : <UploadCloud className="h-4 w-4" />} Profile the data →
        </button>
      </div>
    </>
  );
}
