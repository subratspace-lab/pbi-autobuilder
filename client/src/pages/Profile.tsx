import { useEffect, useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { Analysis } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { Badge, EmptyState, Notice, PageHeader, Spinner, Stat, SuggestButtons, TypeBadge } from '../components/ui';
import { NextStep } from '../components/Layout';

function ProfileTable() {
  const { project, setProject, run, busy } = useStore();
  const [active, setActive] = useState(0);
  if (!project) return null;
  const profile = project.profiles[active];

  if (!project.profiles.length) {
    return (
      <EmptyState
        icon={<RefreshCw className="h-6 w-6" />}
        title="Data not profiled yet"
        text="Profiling scans every column for types, blanks, duplicates, inconsistent text and outliers."
        action={
          <button className="btn-primary" disabled={busy.profile} onClick={async () => setProject((await run('profile', () => api.profile(project.id))) ?? project)}>
            {busy.profile && <Spinner />} Profile now
          </button>
        }
      />
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {project.profiles.map((p, i) => (
            <button key={p.table} className={`tab ${i === active ? 'tab-active' : ''}`} onClick={() => setActive(i)}>
              {p.table}
            </button>
          ))}
        </div>
        <button className="btn-ghost" disabled={busy.profile} onClick={async () => setProject((await run('profile', () => api.profile(project.id))) ?? project)}>
          {busy.profile ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Re-profile
        </button>
      </div>

      {profile && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Rows" value={profile.rowCount.toLocaleString()} />
            <Stat label="Columns" value={profile.columns.length} />
            <Stat label="Duplicate rows" value={profile.duplicateRows} hint={profile.duplicateRows ? 'exact duplicates' : 'none'} />
            <Stat label="Blank rows" value={profile.blankRows} />
            <Stat label="Date format" value={profile.culture === 'en-GB' ? 'D/M/Y' : 'M/D/Y'} hint={profile.culture} />
          </div>
          <div className="card scrollbar-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Column</th>
                  <th className="px-3 py-2.5">Type</th>
                  <th className="px-3 py-2.5 text-right">Blank</th>
                  <th className="px-3 py-2.5 text-right">Distinct</th>
                  <th className="px-3 py-2.5">Range</th>
                  <th className="px-3 py-2.5">Top values</th>
                  <th className="px-3 py-2.5">Issues</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {profile.columns.map((c) => (
                  <tr key={c.name} className="align-top">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{c.name}</td>
                    <td className="px-3 py-2.5">
                      <TypeBadge type={c.inferredType} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span className={c.nullPct > 20 ? 'text-red-600' : c.nullPct > 0 ? 'text-amber-600' : 'text-slate-400'}>{c.nullPct}%</span>
                      <div className="mt-1 h-1 w-16 rounded bg-slate-100">
                        <div className="h-1 rounded bg-amber-400" style={{ width: `${Math.min(100, c.nullPct)}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.distinct.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-600">
                      {c.min !== undefined ? (
                        <>
                          {String(c.min)} → {String(c.max)}
                          {c.mean !== undefined && <div className="text-slate-400">avg {c.mean.toLocaleString()}</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {c.topValues.slice(0, 4).map((t) => (
                          <span key={t.value} className="max-w-[140px] truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600" title={`${t.value} (${t.count})`}>
                            {t.value} <span className="text-slate-400">{t.count}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.issues.length ? (
                        <ul className="space-y-0.5 text-xs text-amber-700">
                          {c.issues.map((i) => (
                            <li key={i} className="flex gap-1">
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {i}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Badge tone="green">clean</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function AnalysisEditor() {
  const { project, setProject, run, busy, toast } = useStore();
  const [a, setA] = useState<Analysis | undefined>(project?.analysis);
  useEffect(() => setA(project?.analysis), [project?.analysis]);
  if (!project) return null;

  const suggest = async (mode: 'ai' | 'rules') => {
    const p = await run('analyze', () => api.analyze(project.id, mode));
    if (p) setProject(p);
  };
  const save = async () => {
    if (!a) return;
    const p = await run('saveAnalysis', () => api.saveAnalysis(project.id, a));
    if (p) {
      setProject(p);
      toast('success', 'Business analysis saved');
    }
  };
  const dirty = JSON.stringify(a) !== JSON.stringify(project.analysis);

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Business understanding</h2>
          <p className="text-sm text-slate-500">What the business does, the questions it needs answered and the KPIs. Every later step builds on this.</p>
        </div>
        <SuggestButtons label="Analyze" busy={busy.analyze} onSuggest={suggest} hasExisting={Boolean(project.analysis)} />
      </div>

      {!a ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="Not analysed yet" text="Let the AI read the brief and the data profile, or start from the rule-based summary." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card space-y-4 p-5">
            <div>
              <label className="label">Business summary {a.source === 'ai' && <Badge tone="violet">AI</Badge>}</label>
              <textarea className="input h-36" value={a.businessSummary} onChange={(e) => setA({ ...a, businessSummary: e.target.value })} />
            </div>
            <div>
              <label className="label">Business questions (one per line)</label>
              <textarea
                className="input h-32"
                value={a.businessQuestions.join('\n')}
                onChange={(e) => setA({ ...a, businessQuestions: e.target.value.split('\n') })}
              />
            </div>
            <div>
              <label className="label">Dashboard idea</label>
              <textarea className="input h-20" value={a.dashboardIdea} onChange={(e) => setA({ ...a, dashboardIdea: e.target.value })} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="card p-5">
              <div className="mb-2 flex items-center justify-between">
                <label className="label mb-0">KPIs</label>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setA({ ...a, kpis: [...a.kpis, { name: 'New KPI', definition: '', formulaHint: '' }] })}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {a.kpis.map((k, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
                    <input className="input font-medium" value={k.name} onChange={(e) => setA({ ...a, kpis: a.kpis.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                    <input
                      className="input"
                      placeholder="definition / formula"
                      value={k.definition}
                      title={k.formulaHint}
                      onChange={(e) => setA({ ...a, kpis: a.kpis.map((x, j) => (j === i ? { ...x, definition: e.target.value } : x)) })}
                    />
                    <button className="btn-ghost p-2" onClick={() => setA({ ...a, kpis: a.kpis.filter((_, j) => j !== i) })}>
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <Notice title="Data issues found" items={a.dataIssues} />
          </div>
        </div>
      )}
      {a && dirty && (
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" onClick={save} disabled={busy.saveAnalysis}>
            <Save className="h-4 w-4" /> Save changes
          </button>
        </div>
      )}
    </section>
  );
}

export function ProfilePage() {
  return (
    <>
      <PageHeader step="Step 2" title="Understand the data & the business" subtitle="Profile every column, then build a shared understanding of the business, its questions and its KPIs." />
      <ProfileTable />
      <AnalysisEditor />
      <NextStep current="profile" />
    </>
  );
}
