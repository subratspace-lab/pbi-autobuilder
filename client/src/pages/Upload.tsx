import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSpreadsheet, FileText, Save, Trash2, UploadCloud } from 'lucide-react';
import type { Cell } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { DataTable } from '../components/DataTable';
import { PageHeader, Spinner } from '../components/ui';

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

  useEffect(() => setBrief(project?.brief.text ?? ''), [project?.brief.text]);
  if (!project) return null;

  const upload = async (files: File[], kind: 'data' | 'brief') => {
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
            accept=".csv,.txt,.tsv,.xlsx,.xlsm,.xls"
            label="Drop CSV / Excel files here"
            hint="or click to browse · up to 500 MB each"
            icon={<FileSpreadsheet className="h-8 w-8" />}
            busy={busy.data}
            onFiles={(f) => upload(f, 'data')}
          />
          <div className="mt-4 space-y-2">
            {project.tables.map((t) => (
              <div key={t.name} className="card flex items-center gap-3 p-3">
                <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />
                <button className="min-w-0 flex-1 text-left" onClick={() => showPreview(t.name)}>
                  <div className="truncate font-medium text-slate-900">{t.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {t.file}
                    {t.sheet ? ` › ${t.sheet}` : ''} · {t.rowCount.toLocaleString()} rows · {t.headers.length} columns
                  </div>
                </button>
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

      {preview && (
        <section className="mt-8">
          <h2 className="mb-2 font-semibold text-slate-900">
            Raw preview — {preview.table} <span className="font-normal text-slate-500">(first {preview.rows.length} of {preview.total.toLocaleString()} rows)</span>
          </h2>
          <DataTable headers={preview.headers} rows={preview.rows} />
        </section>
      )}

      <div className="mt-8 flex justify-end">
        <button className="btn-primary" disabled={!project.tables.length || busy.profile} onClick={next}>
          {busy.profile ? <Spinner /> : <UploadCloud className="h-4 w-4" />} Profile the data →
        </button>
      </div>
    </>
  );
}
