import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Wand2 } from 'lucide-react';
import type { CleaningOp, CleaningOpKind, CleaningResult, ColumnType, TableCleaning } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { DataTable } from '../components/DataTable';
import { CodeEditor } from '../components/CodeEditor';
import { OP_LABELS, OP_TEMPLATES, OpEditor } from '../components/OpEditor';
import { EmptyState, Notice, PageHeader, Spinner, Stat, SuggestButtons, TypeBadge } from '../components/ui';
import { NextStep } from '../components/Layout';

const TYPES: ColumnType[] = ['text', 'number', 'integer', 'currency', 'date', 'datetime', 'boolean'];
const newId = () => Math.random().toString(16).slice(2, 12) + Math.random().toString(16).slice(2, 12);

export function CleanPage() {
  const { project, setProject, run, busy, toast } = useStore();
  const [table, setTable] = useState<string>('');
  const [cleaning, setCleaning] = useState<TableCleaning | null>(null);
  const [result, setResult] = useState<CleaningResult | null>(null);
  const [view, setView] = useState<'after' | 'before' | 'm' | 'types'>('after');
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const saveTimer = useRef<number>();

  useEffect(() => {
    if (project && (!table || !project.tables.some((t) => t.name === table))) setTable(project.tables[0]?.name ?? '');
  }, [project, table]);

  const load = useCallback(async () => {
    if (!project || !table) return;
    const res = await run('loadCleaning', () => api.cleaning(project.id, table));
    if (res) {
      setCleaning(res.cleaning);
      setResult(res.result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, table, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = (next: TableCleaning) => {
    setCleaning(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const res = await run('saveCleaning', () => api.saveCleaning(project!.id, next.table, next));
      if (res) {
        setResult(res.result);
        setProject(res.project);
      }
    }, 500);
  };

  const suggest = async (mode: 'ai' | 'rules') => {
    if (!project) return;
    const res = await run('suggestCleaning', () => api.suggestCleaning(project.id, mode));
    if (res) {
      setProject(res.project);
      if (res.warnings.length) toast('info', 'Suggestion notes', res.warnings);
      await load();
    }
  };

  const columns = useMemo(() => {
    if (!project || !cleaning) return [];
    const raw = project.tables.find((t) => t.name === table)?.headers ?? [];
    const produced = cleaning.ops.flatMap((o) => (o.op === 'rename' ? [o.to] : o.op === 'splitColumn' ? o.newColumns : o.op === 'addColumn' ? [o.name] : []));
    return [...new Set([...raw, ...produced, ...(result?.columns.map((c) => c.name) ?? [])])];
  }, [project, cleaning, result, table]);

  if (!project) return null;
  if (!project.tables.length) {
    return <EmptyState icon={<Wand2 className="h-6 w-6" />} title="No data yet" text="Upload data first." />;
  }

  const ops = cleaning?.ops ?? [];
  const stat = (id: string) => result?.stepStats.find((s) => s.id === id);
  const updateOps = (next: CleaningOp[]) => cleaning && persist({ ...cleaning, ops: next });
  const addOp = (kind: CleaningOpKind) => {
    const op = { id: newId(), enabled: true, op: kind, ...structuredClone(OP_TEMPLATES[kind]) } as unknown as CleaningOp;
    setJustAdded(op.id);
    updateOps([...ops, op]);
  };

  return (
    <>
      <PageHeader
        step="Step 3"
        title="Clean & transform (Power Query)"
        subtitle="Each step becomes a named step in Power Query's Applied Steps. The preview runs the same logic on your data, so what you see is what Power BI will load."
        actions={<SuggestButtons label="Suggest steps" busy={busy.suggestCleaning} onSuggest={suggest} hasExisting={project.cleaning.some((c) => c.ops.length)} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {project.tables.map((t) => (
            <button key={t.name} className={`tab ${t.name === table ? 'tab-active' : ''}`} onClick={() => setTable(t.name)}>
              {t.name}
            </button>
          ))}
        </div>
        {cleaning && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Dates are
            <select className="input w-auto py-1" value={cleaning.culture} onChange={(e) => persist({ ...cleaning, culture: e.target.value as TableCleaning['culture'] })}>
              <option value="en-US">Month/Day/Year (en-US)</option>
              <option value="en-GB">Day/Month/Year (en-GB)</option>
            </select>
          </label>
        )}
        {(busy.saveCleaning || busy.loadCleaning) && (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <Spinner className="h-3 w-3" /> updating preview…
          </span>
        )}
      </div>

      {result && <Notice title="Some steps were skipped" items={result.warnings} />}

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,420px)_1fr]">
        <section className="space-y-2">
          {ops.length === 0 && (
            <div className="card p-6 text-center text-sm text-slate-500">No steps yet. Use “Suggest steps” or add steps manually.</div>
          )}
          {ops.map((op, i) => (
            <OpEditor
              key={op.id}
              op={op}
              index={i}
              count={ops.length}
              columns={columns}
              stat={stat(op.id)}
              skipped={op.enabled && Boolean(result) && !stat(op.id)}
              startOpen={op.id === justAdded}
              onChange={(next) => updateOps(ops.map((x) => (x.id === op.id ? next : x)))}
              onDelete={() => updateOps(ops.filter((x) => x.id !== op.id))}
              onMove={(d) => {
                const next = [...ops];
                [next[i], next[i + d]] = [next[i + d], next[i]];
                updateOps(next);
              }}
            />
          ))}
          <div className="relative">
            <select className="input cursor-pointer pl-9 text-slate-600" value="" onChange={(e) => e.target.value && addOp(e.target.value as CleaningOpKind)}>
              <option value="">Add a step…</option>
              {Object.entries(OP_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <Plus className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          </div>
        </section>

        <section className="min-w-0">
          {result && (
            <>
              <div className="mb-4 grid grid-cols-3 gap-3">
                <Stat label="Rows before" value={result.rowsBefore.toLocaleString()} />
                <Stat label="Rows after" value={result.rowsAfter.toLocaleString()} hint={`${(result.rowsBefore - result.rowsAfter).toLocaleString()} removed`} />
                <Stat label="Columns" value={result.columns.length} />
              </div>
              <div className="mb-3 flex gap-1 rounded-lg bg-slate-100 p-1">
                {(
                  [
                    ['after', 'Cleaned preview'],
                    ['before', 'Raw'],
                    ['m', 'Power Query M'],
                    ['types', 'Column types'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={`tab ${view === k ? 'tab-active' : ''}`} onClick={() => setView(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {view === 'after' && <DataTable headers={result.previewAfter.headers} rows={result.previewAfter.rows} maxHeight={560} />}
              {view === 'before' && <DataTable headers={result.previewBefore.headers} rows={result.previewBefore.rows} maxHeight={560} />}
              {view === 'm' && <CodeEditor language="powerquery" value={result.m} readOnly height={560} />}
              {view === 'types' && cleaning && (
                <div className="card divide-y divide-slate-100">
                  {result.columns.map((c) => (
                    <div key={c.name} className="flex items-center justify-between px-4 py-2">
                      <span className="font-medium text-slate-800">{c.name}</span>
                      <div className="flex items-center gap-2">
                        <TypeBadge type={c.type} />
                        <select
                          className="input w-36 py-1"
                          value={cleaning.finalTypes?.[c.name] ?? ''}
                          onChange={(e) => {
                            const ft = { ...(cleaning.finalTypes ?? {}) };
                            if (e.target.value) ft[c.name] = e.target.value as ColumnType;
                            else delete ft[c.name];
                            persist({ ...cleaning, finalTypes: ft });
                          }}
                        >
                          <option value="">auto</option>
                          {TYPES.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <NextStep current="clean" />
    </>
  );
}
