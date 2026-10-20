import { useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Plus, Save, Trash2 } from 'lucide-react';
import type { FieldRef, PreviewData, ReportLayout, ReportSpec, VisualSpec, VisualType } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { DashboardPreview } from '../components/DashboardPreview';
import { EmptyState, Notice, PageHeader, Spinner, SuggestButtons } from '../components/ui';
import { NextStep } from '../components/Layout';

const VISUALS: Record<VisualType, { label: string; roles: string[] }> = {
  card: { label: 'KPI card', roles: ['Values'] },
  multiRowCard: { label: 'Multi-row card', roles: ['Values'] },
  lineChart: { label: 'Line chart', roles: ['Category', 'Y', 'Series'] },
  clusteredBarChart: { label: 'Bar chart', roles: ['Category', 'Y', 'Series'] },
  clusteredColumnChart: { label: 'Column chart', roles: ['Category', 'Y', 'Series'] },
  donutChart: { label: 'Donut chart', roles: ['Category', 'Y'] },
  pivotTable: { label: 'Matrix', roles: ['Rows', 'Columns', 'Values'] },
  tableEx: { label: 'Table', roles: ['Values'] },
  map: { label: 'Map', roles: ['Category', 'Size'] },
  slicer: { label: 'Slicer', roles: ['Values'] },
};
const DATE_COLS = ['Date', 'Year', 'Quarter', 'Month', 'Year Month', 'Day of Week'];
const newId = () => Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const key = (f: FieldRef) => `${f.kind}|${f.table}|${f.name}`;

export function DashboardPage() {
  const { project, setProject, run, busy, toast } = useStore();
  const [report, setReport] = useState<ReportSpec | undefined>(project?.report);
  const [preview, setPreview] = useState<{ layout: ReportLayout; data: PreviewData } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => setReport(project?.report), [project?.report]);
  useEffect(() => {
    if (project?.report) void run('preview', async () => setPreview(await api.reportPreview(project.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.report]);

  const fieldOptions = useMemo(() => {
    if (!project?.model) return [] as { group: string; ref: FieldRef }[];
    const out: { group: string; ref: FieldRef }[] = project.measures.map((m) => ({ group: 'Measures', ref: { kind: 'measure', table: '_Measures', name: m.name } }));
    for (const t of project.model.tables) for (const c of t.columns) out.push({ group: t.name, ref: { kind: 'column', table: t.name, name: c } });
    if (project.model.dateTable.enabled) for (const c of DATE_COLS) out.push({ group: project.model.dateTable.name, ref: { kind: 'column', table: project.model.dateTable.name, name: c } });
    return out;
  }, [project?.model, project?.measures]);

  if (!project) return null;
  if (!project.measures.length) return <EmptyState icon={<LayoutDashboard className="h-6 w-6" />} title="Create measures first" text="The dashboard is built from your DAX measures." />;

  const dirty = JSON.stringify(report) !== JSON.stringify(project.report);
  const suggest = async (mode: 'ai' | 'rules') => {
    const res = await run('suggestReport', () => api.suggestReport(project.id, mode));
    if (res) {
      setProject(res.project);
      if (res.issues.length) toast('info', 'Dashboard notes', res.issues);
    }
  };
  const save = async () => {
    if (!report) return;
    const res = await run('saveReport', () => api.saveReport(project.id, report));
    if (res) {
      setProject(res.project);
      if (res.issues.length) toast('info', 'Some fields were adjusted', res.issues);
    }
  };
  const updateVisual = (id: string, patch: Partial<VisualSpec>) => report && setReport({ ...report, visuals: report.visuals.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  const groups = [...new Set(fieldOptions.map((o) => o.group))];

  return (
    <>
      <PageHeader
        step="Step 6"
        title="Dashboard page"
        subtitle="KPI cards on top, trend and breakdown charts in the middle, a detail matrix at the bottom and slicers on the left. The preview uses your real (cleaned) data."
        actions={<SuggestButtons label="Design dashboard" busy={busy.suggestReport} onSuggest={suggest} hasExisting={Boolean(project.report)} />}
      />

      {!report ? (
        <EmptyState icon={<LayoutDashboard className="h-6 w-6" />} title="No dashboard yet" text="Generate a layout from the business KPIs, then fine-tune visuals and colours." />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
          <section className="space-y-4">
            <div className="card space-y-3 p-4">
              <div>
                <label className="label">Title</label>
                <input className="input font-semibold" value={report.title} onChange={(e) => setReport({ ...report, title: e.target.value })} />
              </div>
              <div>
                <label className="label">Subtitle</label>
                <input className="input" value={report.subtitle} onChange={(e) => setReport({ ...report, subtitle: e.target.value })} />
              </div>
              <div>
                <label className="label">Theme colours</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {report.theme.dataColors.map((c, i) => (
                    <input
                      key={i}
                      type="color"
                      value={c}
                      className="h-8 w-8 cursor-pointer rounded border border-slate-200"
                      onChange={(e) =>
                        setReport({ ...report, theme: { ...report.theme, dataColors: report.theme.dataColors.map((x, j) => (j === i ? e.target.value : x)), tableAccent: i === 0 ? e.target.value : report.theme.tableAccent } })
                      }
                    />
                  ))}
                  <span className="ml-2 text-xs text-slate-500">{report.theme.name}</span>
                </div>
              </div>
            </div>

            <div className="card divide-y divide-slate-100">
              {report.visuals.map((v) => (
                <div key={v.id} className="p-3">
                  <div className="flex items-center gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === v.id ? null : v.id)}>
                      <div className="truncate text-sm font-medium text-slate-900">{v.title}</div>
                      <div className="truncate text-xs text-slate-500">
                        {VISUALS[v.type].label} · {v.fields.map((f) => f.field.name).join(', ')}
                      </div>
                    </button>
                    <button className="btn-ghost p-1.5" onClick={() => setReport({ ...report, visuals: report.visuals.filter((x) => x.id !== v.id) })}>
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </button>
                  </div>
                  {open === v.id && (
                    <div className="mt-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <select className="input py-1.5" value={v.type} onChange={(e) => updateVisual(v.id, { type: e.target.value as VisualType })}>
                          {Object.entries(VISUALS).map(([k, x]) => (
                            <option key={k} value={k}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                        <input className="input py-1.5" value={v.title} onChange={(e) => updateVisual(v.id, { title: e.target.value })} />
                      </div>
                      {v.fields.map((f, i) => (
                        <div key={i} className="grid grid-cols-[100px_1fr_auto] gap-2">
                          <select className="input px-2 py-1 text-xs" value={f.role} onChange={(e) => updateVisual(v.id, { fields: v.fields.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}>
                            {VISUALS[v.type].roles.map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </select>
                          <select
                            className="input px-2 py-1 text-xs"
                            value={key(f.field)}
                            onChange={(e) => {
                              const ref = fieldOptions.find((o) => key(o.ref) === e.target.value)?.ref;
                              if (ref) updateVisual(v.id, { fields: v.fields.map((x, j) => (j === i ? { ...x, field: ref } : x)) });
                            }}
                          >
                            {groups.map((g) => (
                              <optgroup key={g} label={g}>
                                {fieldOptions
                                  .filter((o) => o.group === g)
                                  .map((o) => (
                                    <option key={key(o.ref)} value={key(o.ref)}>
                                      {o.ref.name}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>
                          <button className="btn-ghost p-1" onClick={() => updateVisual(v.id, { fields: v.fields.filter((_, j) => j !== i) })}>
                            <Trash2 className="h-3.5 w-3.5 text-slate-400" />
                          </button>
                        </div>
                      ))}
                      <button
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => fieldOptions[0] && updateVisual(v.id, { fields: [...v.fields, { role: VISUALS[v.type].roles[0], field: fieldOptions[0].ref }] })}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add field
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <div className="p-3">
                <button
                  className="btn-ghost w-full text-sm"
                  onClick={() => {
                    const id = newId();
                    const m = fieldOptions.find((o) => o.ref.kind === 'measure');
                    setReport({ ...report, visuals: [...report.visuals, { id, type: 'card', title: m?.ref.name ?? 'New visual', fields: m ? [{ role: 'Values', field: m.ref }] : [] }] });
                    setOpen(id);
                  }}
                >
                  <Plus className="h-4 w-4" /> Add visual
                </button>
              </div>
            </div>
          </section>

          <section className="min-w-0">
            {dirty && (
              <Notice tone="blue">
                Unsaved changes — save to refresh the preview.{' '}
                <button className="ml-2 font-semibold underline" onClick={save}>
                  {busy.saveReport ? 'Saving…' : 'Save now'}
                </button>
              </Notice>
            )}
            {busy.preview && !preview && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner /> Rendering preview…
              </div>
            )}
            {preview && project.report && <DashboardPreview report={project.report} layout={preview.layout} data={preview.data} measures={project.measures} />}
            <p className="mt-2 text-xs text-slate-500">
              Preview with real numbers for simple measures; time-intelligence values appear after refresh in Power BI. Final styling comes from the generated Power BI theme.
            </p>
          </section>
        </div>
      )}

      {dirty && (
        <div className="sticky bottom-4 mt-4 flex justify-end">
          <button className="btn-primary shadow-lg" onClick={save} disabled={busy.saveReport}>
            {busy.saveReport ? <Spinner /> : <Save className="h-4 w-4" />} Save dashboard
          </button>
        </div>
      )}
      <NextStep current="dashboard" />
    </>
  );
}
