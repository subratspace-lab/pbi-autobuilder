import type { Analysis, CleaningOp, MeasureSpec, ModelSpec, Project, ReportSpec } from '../../../shared/types.js';
import { askJson, loadPrompt } from './llm.js';
import { analysisSchema, cleaningOpSchema, cleaningSuggestionSchema, measuresSchema, modelSchema, reportSchema } from './schemas.js';
import { getPipeline, getRaw } from './store.js';
import { profileForPrompt } from './profile.js';
import { buildModelData, DATE_COLUMNS, MEASURE_TABLE, modelColumns, validateModel } from './model.js';
import { DEFAULT_THEME, normalizeVisual } from './report.js';
import { newId } from './rules.js';

// AI-backed suggestions. The model only ever returns JSON specs; everything
// is validated and normalised here before the user sees it.

const MAX_BRIEF = 12000;

function brief(project: Project) {
  const text = project.brief.text.trim();
  if (!text) return '(No brief provided — infer the business from the data.)';
  return text.length > MAX_BRIEF ? `${text.slice(0, MAX_BRIEF)}\n…(truncated)` : text;
}

function analysisText(project: Project) {
  const a = project.analysis;
  if (!a) return '(not analysed yet)';
  return JSON.stringify({ summary: a.businessSummary, questions: a.businessQuestions, kpis: a.kpis, dashboard: a.dashboardIdea }, null, 1);
}

function profilesText(project: Project) {
  return project.profiles.map((p) => {
    const t = project.tables.find((x) => x.name === p.table)!;
    const raw = getRaw(project.id, t);
    return profileForPrompt(p, { headers: raw.headers, rows: raw.rows.slice(0, 15) });
  });
}

function distinctOf(rows: unknown[][], i: number) {
  return new Set(rows.map((r) => r[i]).filter((v) => v !== null && v !== '')).size;
}

export async function aiAnalyze(project: Project): Promise<Analysis> {
  const res = await askJson(loadPrompt('analyze', { brief: brief(project), profiles: profilesText(project) }), analysisSchema);
  return { ...res, source: 'ai' };
}

export async function aiCleaning(project: Project): Promise<{ ops: Record<string, CleaningOp[]>; warnings: string[] }> {
  const res = await askJson(
    loadPrompt('cleaning', { analysis: analysisText(project), profiles: profilesText(project) }),
    cleaningSuggestionSchema,
  );
  const warnings: string[] = [];
  const ops: Record<string, CleaningOp[]> = {};
  for (const t of res.tables) {
    const table = project.tables.find((x) => x.name.toLowerCase() === t.table.toLowerCase());
    if (!table) {
      warnings.push(`AI referred to unknown table "${t.table}"`);
      continue;
    }
    ops[table.name] = [];
    for (const raw of t.ops) {
      const parsed = cleaningOpSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`${table.name}: ignored invalid step ${JSON.stringify(raw).slice(0, 120)}`);
        continue;
      }
      ops[table.name].push({ ...parsed.data, id: newId(), enabled: true } as CleaningOp);
    }
  }
  return { ops, warnings };
}

export async function aiModel(project: Project): Promise<{ model: ModelSpec; issues: string[] }> {
  const tables = project.tables.map((t) => {
    const p = getPipeline(project, t.name);
    return {
      name: t.name,
      rows: p.rows.length,
      columns: p.columns.map((c, i) => ({ name: c.name, type: c.type, distinct: distinctOf(p.rows, i) })),
    };
  });
  const res = await askJson(loadPrompt('model', { analysis: analysisText(project), tables }), modelSchema);
  const resolveSource = (s: string) => project.tables.find((t) => t.name.toLowerCase() === s.toLowerCase())?.name ?? s;
  const modelTables = res.tables.map((t) => ({ ...t, source: resolveSource(t.source), key: t.key ?? undefined }));
  const dtName = modelTables.some((t) => t.name.toLowerCase() === 'date') ? 'Calendar' : 'Date';
  const spec: ModelSpec = {
    tables: modelTables,
    relationships: res.relationships,
    dateTable: res.dateTable ? { enabled: true, name: dtName, table: res.dateTable.table, column: res.dateTable.column } : { enabled: false, name: dtName, table: '', column: '' },
    source: 'ai',
  };
  return validateModel(project, spec);
}

export async function aiMeasures(project: Project, model: ModelSpec): Promise<MeasureSpec[]> {
  const cols = modelColumns(project, model);
  const tables = Object.fromEntries([...cols.entries()].map(([t, c]) => [t, c.map((x) => `${x.name} (${x.type})`)]));
  const dateTable = model.dateTable.enabled
    ? `Table '${model.dateTable.name}' with columns ${DATE_COLUMNS.map((c) => c.name).join(', ')}; related to '${model.dateTable.table}'[${model.dateTable.column}]. Use '${model.dateTable.name}'[Date] for time intelligence.`
    : 'No date table — skip time intelligence.';
  const res = await askJson(loadPrompt('measures', { analysis: analysisText(project), brief: brief(project), tables, dateTable }), measuresSchema);
  return res.measures.map((m) => ({ ...m, expression: m.expression.replace(/^\s*=\s*/, '').replace(/\\n/g, '\n') }));
}

export async function aiReport(project: Project, model: ModelSpec, measures: MeasureSpec[]): Promise<{ report: ReportSpec; issues: string[] }> {
  const data = buildModelData(project, model);
  const cols = modelColumns(project, model);
  const columns: string[] = [];
  for (const [t, cs] of cols) {
    const d = data.get(t);
    for (const c of cs) {
      if (t === model.dateTable.name) columns.push(`${t} -> ${c.name} (date table)`);
      else if (c.type === 'text' && d) columns.push(`${t} -> ${c.name} (${distinctOf(d.rows, d.headers.indexOf(c.name))})`);
      else if (c.type === 'date') columns.push(`${t} -> ${c.name} (date)`);
    }
  }
  const res = await askJson(
    loadPrompt('report', {
      analysis: analysisText(project),
      brief: brief(project),
      measures: measures.map((m) => `${m.name} [${m.displayFolder}] — ${m.description}`).join('\n'),
      columns: columns.join('\n'),
    }),
    reportSchema,
  );

  const issues: string[] = [];
  const measureNames = new Map(measures.map((m) => [m.name.toLowerCase(), m.name]));
  const visuals = res.visuals.map((v) => {
    const fields = v.fields
      .map((f) => {
        if (f.field.kind === 'measure') {
          const name = measureNames.get(f.field.name.toLowerCase());
          if (!name) {
            issues.push(`"${v.title}": measure "${f.field.name}" does not exist — removed`);
            return null;
          }
          return { role: f.role, field: { kind: 'measure' as const, table: MEASURE_TABLE, name } };
        }
        const table = [...cols.keys()].find((t) => t.toLowerCase() === f.field.table.toLowerCase());
        const col = table && cols.get(table)!.find((c) => c.name.toLowerCase() === f.field.name.toLowerCase());
        if (!table || !col) {
          issues.push(`"${v.title}": column ${f.field.table}[${f.field.name}] does not exist — removed`);
          return null;
        }
        return { role: f.role, field: { kind: 'column' as const, table, name: col.name } };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
    const { visual, issues: vi } = normalizeVisual({ id: newId(), type: v.type, title: v.title, fields, sortDescending: v.sortDescending });
    issues.push(...vi);
    return visual;
  });

  return {
    report: {
      title: res.title,
      subtitle: res.subtitle,
      visuals: visuals.filter((v) => v.fields.length),
      theme: res.theme ?? DEFAULT_THEME,
      source: 'ai',
    },
    issues,
  };
}
