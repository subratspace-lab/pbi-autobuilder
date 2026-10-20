import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, Folder, Plus, Save, Sigma, Trash2, XCircle } from 'lucide-react';
import type { LintIssue, MeasureCheck, MeasureSpec } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { CodeEditor } from '../components/CodeEditor';
import { EmptyState, formatValue, Notice, PageHeader, Spinner, SuggestButtons } from '../components/ui';
import { NextStep } from '../components/Layout';

const FORMATS = ['#,0', '#,0.00', '0.0%', '0.00%', '$#,0', '$#,0.00', '0'];

export function MeasuresPage() {
  const { project, setProject, run, busy, toast } = useStore();
  const [measures, setMeasures] = useState<MeasureSpec[]>(project?.measures ?? []);
  const [lint, setLint] = useState<LintIssue[]>([]);
  const [values, setValues] = useState<MeasureCheck[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => setMeasures(project?.measures ?? []), [project?.measures]);
  useEffect(() => {
    if (project?.model && project.measures.length) {
      void run('check', async () => {
        const res = await api.checkMeasures(project.id);
        setLint(res.lint);
        setValues(res.values);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.measures]);

  const folders = useMemo(() => {
    const map = new Map<string, number[]>();
    measures.forEach((m, i) => map.set(m.displayFolder || '(no folder)', [...(map.get(m.displayFolder || '(no folder)') ?? []), i]));
    return [...map.entries()];
  }, [measures]);

  if (!project) return null;
  if (!project.model) return <EmptyState icon={<Sigma className="h-6 w-6" />} title="Build the model first" text="Measures reference the tables and columns of the data model." />;

  const dirty = JSON.stringify(measures) !== JSON.stringify(project.measures);
  const m = measures[selected];
  const issuesFor = (name: string) => lint.filter((l) => l.measure === name);
  const errors = lint.filter((l) => l.level === 'error').length;

  const suggest = async (mode: 'ai' | 'rules') => {
    const res = await run('suggestMeasures', () => api.suggestMeasures(project.id, mode));
    if (res) {
      setProject(res.project);
      setLint(res.lint);
      setSelected(0);
    }
  };
  const save = async () => {
    const res = await run('saveMeasures', () => api.saveMeasures(project.id, measures));
    if (res) {
      setProject(res.project);
      setLint(res.lint);
      toast(res.lint.some((l) => l.level === 'error') ? 'error' : 'success', res.lint.some((l) => l.level === 'error') ? 'Saved — but some measures have errors' : 'Measures saved');
    }
  };
  const update = (patch: Partial<MeasureSpec>) => setMeasures(measures.map((x, i) => (i === selected ? { ...x, ...patch } : x)));

  return (
    <>
      <PageHeader
        step="Step 5"
        title="DAX measures"
        subtitle="Base measures first (sums, counts), then ratios with DIVIDE, then time intelligence on the Date table. All measures live in one _Measures table, organised in display folders."
        actions={<SuggestButtons label="Write measures" busy={busy.suggestMeasures} onSuggest={suggest} hasExisting={project.measures.length > 0} />}
      />
      {errors > 0 && (
        <Notice tone="red" title={`${errors} problem(s) found`}>
          Measures with errors are left out of the export until fixed.
        </Notice>
      )}

      {!measures.length ? (
        <EmptyState icon={<Sigma className="h-6 w-6" />} title="No measures yet" text="Generate them from the KPIs, or add your own." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="card scrollbar-thin max-h-[640px] overflow-y-auto p-2">
            {folders.map(([folder, idx]) => (
              <div key={folder} className="mb-2">
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <Folder className="h-3.5 w-3.5" /> {folder}
                </div>
                {idx.map((i) => {
                  const mm = measures[i];
                  const iss = issuesFor(mm.name);
                  const v = values.find((x) => x.name === mm.name);
                  return (
                    <button
                      key={i}
                      onClick={() => setSelected(i)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${i === selected ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50'}`}
                    >
                      {iss.some((x) => x.level === 'error') ? (
                        <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                      ) : iss.length ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                      ) : (
                        <Calculator className="h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{mm.name}</span>
                      <span className="text-xs tabular-nums text-slate-400">{v?.value !== null && v?.value !== undefined ? formatValue(v.value, mm.formatString) : ''}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            <button
              className="btn-ghost mt-1 w-full justify-start text-sm"
              onClick={() => {
                setMeasures([...measures, { name: `New Measure ${measures.length + 1}`, expression: '', formatString: '#,0', displayFolder: 'Base', description: '' }]);
                setSelected(measures.length);
              }}
            >
              <Plus className="h-4 w-4" /> New measure
            </button>
          </aside>

          {m && (
            <section className="card space-y-4 p-5">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
                <div>
                  <label className="label">Name</label>
                  <input className="input font-medium" value={m.name} onChange={(e) => update({ name: e.target.value })} />
                </div>
                <div>
                  <label className="label">Format</label>
                  <input className="input font-mono" list="formats" value={m.formatString} onChange={(e) => update({ formatString: e.target.value })} />
                  <datalist id="formats">
                    {FORMATS.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="label">Display folder</label>
                  <input className="input" value={m.displayFolder} onChange={(e) => update({ displayFolder: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="label">DAX expression</label>
                <CodeEditor language="dax" value={m.expression} onChange={(v) => update({ expression: v })} height={200} />
                <p className="mt-1 text-xs text-slate-400">
                  Measure: <code className="text-slate-600">{m.name} = …</code> · reference columns as <code>'Table'[Column]</code>, measures as <code>[Measure]</code>
                </p>
              </div>
              <div>
                <label className="label">Description (shown as a tooltip in Power BI)</label>
                <input className="input" value={m.description} onChange={(e) => update({ description: e.target.value })} />
              </div>
              {issuesFor(m.name).map((i, k) => (
                <div key={k} className={`flex items-center gap-2 text-sm ${i.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                  {i.level === 'error' ? <XCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {i.message}
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <div className="text-sm text-slate-500">
                  Total over all data:{' '}
                  <span className="font-semibold text-slate-900">
                    {(() => {
                      const v = values.find((x) => x.name === m.name);
                      return v?.value !== null && v?.value !== undefined ? formatValue(v.value, m.formatString) : v?.note ?? '—';
                    })()}
                  </span>
                </div>
                <button
                  className="btn-danger"
                  onClick={() => {
                    setMeasures(measures.filter((_, i) => i !== selected));
                    setSelected(Math.max(0, selected - 1));
                  }}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {dirty && (
        <div className="sticky bottom-4 mt-4 flex justify-end">
          <button className="btn-primary shadow-lg" onClick={save} disabled={busy.saveMeasures}>
            {busy.saveMeasures ? <Spinner /> : <Save className="h-4 w-4" />} Save & check measures
          </button>
        </div>
      )}
      <NextStep current="measures" />
    </>
  );
}
