import type { Cell, CleanedColumn, ColumnType, DateTableSpec, ModelSpec, ModelTable, Project, Relationship } from '../../../shared/types.js';
import { getPipeline } from './store.js';

export const MEASURE_TABLE = '_Measures';

export const DATE_COLUMNS: CleanedColumn[] = [
  { name: 'Date', type: 'date' },
  { name: 'Year', type: 'integer' },
  { name: 'Quarter', type: 'text' },
  { name: 'Month Number', type: 'integer' },
  { name: 'Month', type: 'text' },
  { name: 'Year Month', type: 'text' },
  { name: 'Day of Week', type: 'text' },
  { name: 'Day of Week Number', type: 'integer' },
];

/** Columns of each model table (including the generated Date table). */
export function modelColumns(project: Project, model: ModelSpec): Map<string, CleanedColumn[]> {
  const out = new Map<string, CleanedColumn[]>();
  for (const t of model.tables) {
    const schema = project.cleanedSchemas[t.source] ?? [];
    out.set(
      t.name,
      t.columns.map((c) => schema.find((s) => s.name === c) ?? { name: c, type: 'text' as ColumnType }),
    );
  }
  if (model.dateTable.enabled) out.set(model.dateTable.name, DATE_COLUMNS);
  return out;
}

/** Fix what can be fixed and report the rest. Returns a cleaned copy of the spec. */
export function validateModel(project: Project, spec: ModelSpec): { model: ModelSpec; issues: string[] } {
  const issues: string[] = [];
  const names = new Set<string>();
  const reserved = new Set(['datafolder', MEASURE_TABLE.toLowerCase()]);
  if (spec.dateTable.enabled) reserved.add(spec.dateTable.name.toLowerCase());

  const tables: ModelTable[] = [];
  for (const t of spec.tables) {
    const schema = project.cleanedSchemas[t.source];
    if (!schema) {
      issues.push(`Table "${t.name}": source "${t.source}" is not a cleaned table — removed`);
      continue;
    }
    const name = t.name.trim();
    if (!name || names.has(name.toLowerCase()) || reserved.has(name.toLowerCase())) {
      issues.push(`Table name "${t.name}" is empty, duplicated or reserved — removed`);
      continue;
    }
    names.add(name.toLowerCase());
    const columns = [...new Set(t.columns)].filter((c) => {
      const ok = schema.some((s) => s.name === c);
      if (!ok) issues.push(`Table "${name}": column "${c}" does not exist in "${t.source}" — removed`);
      return ok;
    });
    if (!columns.length) {
      issues.push(`Table "${name}" has no valid columns — removed`);
      continue;
    }
    // Keep a band column's hidden sort column next to it.
    for (const c of [...columns]) {
      const sortBy = schema.find((s) => s.name === c)?.sortBy;
      if (sortBy && !columns.includes(sortBy) && schema.some((s) => s.name === sortBy)) columns.push(sortBy);
    }
    let key = t.key ?? undefined;
    if (t.role === 'dimension') {
      if (!key || !columns.includes(key)) {
        issues.push(`Dimension "${name}" needs a key column — using "${columns[0]}"`);
        key = columns[0];
      }
    }
    tables.push({ ...t, name, columns, key });
  }

  const cols = modelColumns(project, { ...spec, tables });
  const relationships = spec.relationships.filter((r) => {
    const from = cols.get(r.fromTable)?.find((c) => c.name === r.fromColumn);
    const to = cols.get(r.toTable)?.find((c) => c.name === r.toColumn);
    if (!from || !to) {
      issues.push(`Relationship ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}] refers to a missing column — removed`);
      return false;
    }
    if (r.fromTable === r.toTable) {
      issues.push(`Relationship inside the same table "${r.fromTable}" — removed`);
      return false;
    }
    return true;
  });

  const dt = spec.dateTable;
  if (dt.enabled) {
    const col = cols.get(dt.table)?.find((c) => c.name === dt.column);
    if (!col || (col.type !== 'date' && col.type !== 'datetime')) {
      issues.push(`Date table: "${dt.table}[${dt.column}]" is not a date column — Date table disabled`);
      dt.enabled = false;
    } else if (col.type === 'datetime') {
      issues.push(`"${dt.table}[${dt.column}]" is a datetime; set it to date in cleaning so it matches the Date table`);
    }
  }
  // Ensure the date relationship exists exactly once.
  const dateRels: Relationship[] = dt.enabled
    ? [
        {
          fromTable: dt.table,
          fromColumn: dt.column,
          toTable: dt.name,
          toColumn: 'Date',
        },
      ]
    : [];
  const rels = [
    ...relationships.filter((r) => !(dt.enabled && r.toTable === dt.name && r.fromTable === dt.table && r.fromColumn === dt.column)),
    ...dateRels,
  ];

  deactivateAmbiguousPaths(rels, tables, dt, issues);

  return { model: { ...spec, tables, relationships: rels, dateTable: { ...dt } }, issues };
}

/**
 * Power BI allows only one active filter path between any two tables, so the
 * active relationships must form a tree (no loops). E.g. POLICY→AGENT→BRANCH
 * plus POLICY→BRANCH is ambiguous and Power BI refuses to open the model.
 * Relationships are kept in priority order — the Date table, then fact → dimension
 * (the star schema), then dimension → dimension — and any relationship that
 * would close a loop is made inactive (still usable in DAX with USERELATIONSHIP).
 */
export function deactivateAmbiguousPaths(rels: Relationship[], tables: ModelTable[], dt: DateTableSpec, issues: string[]) {
  const parent = new Map<string, string>();
  const root = (t: string): string => {
    let r = t;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(t, r);
    return r;
  };
  const role = (t: string) => tables.find((x) => x.name === t)?.role;
  const priority = (r: Relationship) => (dt.enabled && r.toTable === dt.name ? 0 : role(r.fromTable) === 'fact' ? 1 : 2);
  const ordered = rels.filter((r) => r.active !== false).sort((a, b) => priority(a) - priority(b));
  for (const r of ordered) {
    const a = root(r.fromTable);
    const b = root(r.toTable);
    if (a === b) {
      r.active = false;
      issues.push(
        `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}] set to inactive: ${r.fromTable} and ${r.toTable} are already connected through other tables (Power BI allows only one active path)`,
      );
    } else {
      parent.set(a, b);
    }
  }
}

export interface ModelTableData {
  headers: string[];
  rows: Cell[][];
}

/** Materialise model tables in JS (same logic as the generated M) for checks & previews. */
export function buildModelData(project: Project, model: ModelSpec): Map<string, ModelTableData> {
  const out = new Map<string, ModelTableData>();
  for (const t of model.tables) {
    const pipe = getPipeline(project, t.source);
    const ids = t.columns.map((c) => pipe.headers.indexOf(c));
    let rows = pipe.rows.map((r) => ids.map((i) => (i >= 0 ? r[i] : null)));
    if (t.role === 'dimension' && t.key) {
      const k = t.columns.indexOf(t.key);
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        if (r[k] === null || r[k] === '') return false;
        // Power BI compares relationship keys case-insensitively.
        const key = String(r[k]).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    out.set(t.name, { headers: [...t.columns], rows });
  }
  return out;
}
