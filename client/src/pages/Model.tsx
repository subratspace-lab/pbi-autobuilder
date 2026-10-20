import { useEffect, useState } from 'react';
import { Database, Plus, Save, Trash2 } from 'lucide-react';
import type { ModelSpec, ModelTable, Relationship } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { SchemaCanvas } from '../components/SchemaCanvas';
import { Badge, EmptyState, Notice, PageHeader, Spinner, SuggestButtons } from '../components/ui';
import { NextStep } from '../components/Layout';

const DATE_COLS = ['Date', 'Year', 'Quarter', 'Month Number', 'Month', 'Year Month', 'Day of Week', 'Day of Week Number'];

export function ModelPage() {
  const { project, setProject, run, busy } = useStore();
  const [model, setModel] = useState<ModelSpec | undefined>(project?.model);
  const [issues, setIssues] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setModel(project?.model), [project?.model]);
  if (!project) return null;

  const schemas = project.cleanedSchemas;
  const sources = Object.keys(schemas);
  const dirty = JSON.stringify(model) !== JSON.stringify(project.model);

  const suggest = async (mode: 'ai' | 'rules') => {
    const res = await run('suggestModel', () => api.suggestModel(project.id, mode));
    if (res) {
      setProject(res.project);
      setIssues(res.issues);
      setSelected(0);
    }
  };
  const save = async () => {
    if (!model) return;
    const res = await run('saveModel', () => api.saveModel(project.id, model));
    if (res) {
      setProject(res.project);
      setIssues(res.issues);
    }
  };

  const tableColumns = (name: string): string[] => {
    if (model?.dateTable.enabled && name === model.dateTable.name) return DATE_COLS;
    return model?.tables.find((t) => t.name === name)?.columns ?? [];
  };
  const allTables = model ? [...model.tables.map((t) => t.name), ...(model.dateTable.enabled ? [model.dateTable.name] : [])] : [];

  const updateTable = (i: number, patch: Partial<ModelTable>) => model && setModel({ ...model, tables: model.tables.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const updateRel = (i: number, patch: Partial<Relationship>) =>
    model && setModel({ ...model, relationships: model.relationships.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const t = model?.tables[selected];

  return (
    <>
      <PageHeader
        step="Step 4"
        title="Data model (star schema)"
        subtitle="Fact tables hold the transactions, dimensions describe them, and a generated Date table powers time intelligence. Relationships are one-to-many, single direction."
        actions={<SuggestButtons label="Design model" busy={busy.suggestModel} onSuggest={suggest} hasExisting={Boolean(project.model)} />}
      />
      {!sources.length && <Notice title="Clean the data first">Open the Clean step once so the cleaned table schemas are known.</Notice>}
      {sources.length > 0 && !project.cleaning.some((c) => c.ops.length > 0) && (
        <Notice title="No cleaning steps yet">
          The model is built on the raw data. Go to <b>Clean → Suggest steps</b> first to fix types, text and duplicates and to add useful bands (e.g. DPD buckets,
          score and age bands), then redesign the model.
        </Notice>
      )}
      <Notice title="Model notes" items={issues} />

      {!model ? (
        <EmptyState icon={<Database className="h-6 w-6" />} title="No model yet" text="Let the AI split your data into a star schema, or start with the rule-based model (one table per file + Date table)." />
      ) : (
        <>
          <SchemaCanvas model={model} schemas={schemas} measureCount={project.measures.length} />

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold text-slate-900">Tables</h2>
                <button
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => {
                    const src = sources[0];
                    setModel({ ...model, tables: [...model.tables, { name: `New Table ${model.tables.length + 1}`, role: 'dimension', source: src, columns: [], key: undefined }] });
                    setSelected(model.tables.length);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Add table
                </button>
              </div>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {model.tables.map((x, i) => (
                  <button key={i} className={`tab border ${i === selected ? 'tab-active border-brand-500' : 'border-slate-200'}`} onClick={() => setSelected(i)}>
                    {x.name} <Badge tone={x.role === 'fact' ? 'blue' : 'green'}>{x.role}</Badge>
                  </button>
                ))}
              </div>
              {t && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-1">
                      <label className="label">Name</label>
                      <input className="input" value={t.name} onChange={(e) => updateTable(selected, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Role</label>
                      <select className="input" value={t.role} onChange={(e) => updateTable(selected, { role: e.target.value as ModelTable['role'] })}>
                        <option value="fact">fact</option>
                        <option value="dimension">dimension</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Built from</label>
                      <select className="input" value={t.source} onChange={(e) => updateTable(selected, { source: e.target.value, columns: [] })}>
                        {sources.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {t.role === 'dimension' && (
                    <div>
                      <label className="label">Key column (one row per key)</label>
                      <select className="input" value={t.key ?? ''} onChange={(e) => updateTable(selected, { key: e.target.value || undefined })}>
                        <option value="">— choose —</option>
                        {t.columns.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="label">Columns</label>
                    <div className="flex flex-wrap gap-1.5">
                      {(schemas[t.source] ?? []).map((c) => {
                        const on = t.columns.includes(c.name);
                        return (
                          <button
                            key={c.name}
                            className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'}`}
                            onClick={() => updateTable(selected, { columns: on ? t.columns.filter((x) => x !== c.name) : [...t.columns, c.name] })}
                          >
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    className="btn-danger px-2 py-1 text-xs"
                    onClick={() => {
                      setModel({ ...model, tables: model.tables.filter((_, j) => j !== selected), relationships: model.relationships.filter((r) => r.fromTable !== t.name && r.toTable !== t.name) });
                      setSelected(0);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove table
                  </button>
                </div>
              )}
            </section>

            <section className="space-y-6">
              <div className="card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold text-slate-900">Relationships</h2>
                  <button
                    className="btn-ghost px-2 py-1 text-xs"
                    onClick={() => setModel({ ...model, relationships: [...model.relationships, { fromTable: model.tables[0]?.name ?? '', fromColumn: '', toTable: '', toColumn: '' }] })}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
                <div className="space-y-2">
                  {model.relationships.map((r, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto_1fr_1fr_auto] items-center gap-1.5 text-xs">
                      <select className="input px-2 py-1 text-xs" value={r.fromTable} onChange={(e) => updateRel(i, { fromTable: e.target.value, fromColumn: '' })}>
                        <option value="">many…</option>
                        {allTables.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <select className="input px-2 py-1 text-xs" value={r.fromColumn} onChange={(e) => updateRel(i, { fromColumn: e.target.value })}>
                        <option value="">column</option>
                        {tableColumns(r.fromTable).map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <span className="text-slate-400">*→1</span>
                      <select className="input px-2 py-1 text-xs" value={r.toTable} onChange={(e) => updateRel(i, { toTable: e.target.value, toColumn: '' })}>
                        <option value="">one…</option>
                        {allTables.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <select className="input px-2 py-1 text-xs" value={r.toColumn} onChange={(e) => updateRel(i, { toColumn: e.target.value })}>
                        <option value="">column</option>
                        {tableColumns(r.toTable).map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <button className="btn-ghost p-1" onClick={() => setModel({ ...model, relationships: model.relationships.filter((_, j) => j !== i) })}>
                        <Trash2 className="h-3.5 w-3.5 text-slate-400" />
                      </button>
                    </div>
                  ))}
                  {!model.relationships.length && <p className="text-sm text-slate-500">No relationships.</p>}
                </div>
              </div>

              <div className="card p-5">
                <label className="flex items-center gap-2 font-semibold text-slate-900">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={model.dateTable.enabled}
                    onChange={(e) => setModel({ ...model, dateTable: { ...model.dateTable, enabled: e.target.checked } })}
                  />
                  Generate a Date table
                </label>
                <p className="mt-1 text-xs text-slate-500">DAX CALENDAR table with Year, Quarter, Month, Year Month… marked as the date table.</p>
                {model.dateTable.enabled && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div>
                      <label className="label">Name</label>
                      <input className="input" value={model.dateTable.name} onChange={(e) => setModel({ ...model, dateTable: { ...model.dateTable, name: e.target.value } })} />
                    </div>
                    <div>
                      <label className="label">Link to table</label>
                      <select className="input" value={model.dateTable.table} onChange={(e) => setModel({ ...model, dateTable: { ...model.dateTable, table: e.target.value, column: '' } })}>
                        {model.tables.map((x) => (
                          <option key={x.name}>{x.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Date column</label>
                      <select className="input" value={model.dateTable.column} onChange={(e) => setModel({ ...model, dateTable: { ...model.dateTable, column: e.target.value } })}>
                        <option value="">— choose —</option>
                        {(model.tables.find((x) => x.name === model.dateTable.table)?.columns ?? [])
                          .filter((c) => {
                            const src = model.tables.find((x) => x.name === model.dateTable.table)!.source;
                            const type = schemas[src]?.find((s) => s.name === c)?.type;
                            return type === 'date' || type === 'datetime';
                          })
                          .map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {dirty && (
            <div className="sticky bottom-4 mt-4 flex justify-end">
              <button className="btn-primary shadow-lg" onClick={save} disabled={busy.saveModel}>
                {busy.saveModel ? <Spinner /> : <Save className="h-4 w-4" />} Save & validate model
              </button>
            </div>
          )}
        </>
      )}
      <NextStep current="model" />
    </>
  );
}
