import type { Cell, MeasureCheck, ModelSpec, PreviewData, Project, ReportSpec } from '../../../shared/types.js';
import { evaluateMeasure, type EvalContext, type EvalTable } from './dax.js';
import { buildModelData, type ModelTableData } from './model.js';
import { getPipeline } from './store.js';
import { categoryRoles, valueRoles } from './report.js';

// Computes measure values in JS (for simple measures) so the user can check
// totals against Power BI and see a realistic dashboard preview.

interface Filter {
  table: string;
  column: string;
  value: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function datePart(iso: Cell, column: string): Cell {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  switch (column) {
    case 'Date':
      return iso.slice(0, 10);
    case 'Year':
      return y;
    case 'Quarter':
      return `Q${Math.ceil(m / 3)}`;
    case 'Month Number':
      return m;
    case 'Month':
      return MONTHS[m - 1];
    case 'Year Month':
      return `${y}-${String(m).padStart(2, '0')}`;
    case 'Day of Week':
      return DAYS[dow];
    case 'Day of Week Number':
      return dow === 0 ? 7 : dow;
  }
  return null;
}

const norm = (v: Cell) => (v === null ? '' : String(v).toLowerCase());

class Previewer {
  private data: Map<string, ModelTableData>;
  private base = new Map<string, EvalTable>();

  constructor(
    private project: Project,
    private model: ModelSpec,
    private measures: Project['measures'],
  ) {
    this.data = buildModelData(project, model);
    for (const t of model.tables) {
      // Facts are evaluated on the full cleaned source so columns that moved
      // to a dimension (star split from one flat file) can still be filtered.
      if (t.role === 'fact') {
        const p = getPipeline(project, t.source);
        this.base.set(t.name, { headers: p.headers, rows: p.rows });
      } else {
        const d = this.data.get(t.name);
        if (d) this.base.set(t.name, d);
      }
    }
  }

  private filterRows(table: string, f: Filter | null): EvalTable | null {
    const base = this.base.get(table);
    if (!base) return null;
    if (!f) return base;
    const target = f.value.toLowerCase();
    const dt = this.model.dateTable;
    const tSpec = this.model.tables.find((t) => t.name === table)!;
    const fSpec = this.model.tables.find((t) => t.name === f.table);

    const sameSource = f.table === table || (fSpec && fSpec.source === tSpec.source);
    const ci = base.headers.indexOf(f.column);
    if (sameSource && ci >= 0) {
      return { headers: base.headers, rows: base.rows.filter((r) => norm(r[ci]) === target) };
    }
    if (dt.enabled && f.table === dt.name && dt.table === table) {
      const di = base.headers.indexOf(dt.column);
      if (di < 0) return null;
      return { headers: base.headers, rows: base.rows.filter((r) => norm(datePart(r[di], f.column)) === target) };
    }
    const rel = this.model.relationships.find((r) => r.fromTable === table && r.toTable === f.table && r.active !== false);
    if (rel) {
      const dim = this.data.get(f.table);
      const fi = base.headers.indexOf(rel.fromColumn);
      if (!dim || fi < 0) return null;
      const ki = dim.headers.indexOf(rel.toColumn);
      const vi = dim.headers.indexOf(f.column);
      if (ki < 0 || vi < 0) return null;
      const lookup = new Map(dim.rows.map((r) => [norm(r[ki]), norm(r[vi])]));
      return { headers: base.headers, rows: base.rows.filter((r) => lookup.get(norm(r[fi])) === target) };
    }
    return null;
  }

  context(f: Filter | null): EvalContext {
    return {
      measures: this.measures,
      model: this.model,
      rowsOf: (t) => this.filterRows(t, f),
    };
  }

  measure(name: string, f: Filter | null) {
    return evaluateMeasure(name, this.context(f));
  }

  /** Label → position for columns with a "sort by" column (bands/buckets), else null. */
  sortOrder(table: string, column: string): Map<string, number> | null {
    const spec = this.model.tables.find((t) => t.name === table);
    const sortBy = spec && this.project.cleanedSchemas[spec.source]?.find((c) => c.name === column)?.sortBy;
    const d = this.data.get(table);
    if (!sortBy || !d) return null;
    const ci = d.headers.indexOf(column);
    const si = d.headers.indexOf(sortBy);
    if (ci < 0 || si < 0) return null;
    const order = new Map<string, number>();
    for (const r of d.rows) if (r[ci] !== null && typeof r[si] === 'number') order.set(norm(r[ci]), r[si] as number);
    return order;
  }

  categoryValues(table: string, column: string): Cell[] {
    const dt = this.model.dateTable;
    let values: Cell[] = [];
    if (dt.enabled && table === dt.name) {
      const src = this.base.get(dt.table);
      const di = src?.headers.indexOf(dt.column) ?? -1;
      if (src && di >= 0) values = src.rows.map((r) => datePart(r[di], column));
    } else {
      const d = this.data.get(table);
      const ci = d?.headers.indexOf(column) ?? -1;
      if (d && ci >= 0) values = d.rows.map((r) => r[ci]);
    }
    const seen = new Map<string, Cell>();
    for (const v of values) if (v !== null && v !== '' && !seen.has(norm(v))) seen.set(norm(v), v);
    return [...seen.values()];
  }
}

export function measureChecks(project: Project): MeasureCheck[] {
  if (!project.model) return [];
  const p = new Previewer(project, project.model, project.measures);
  return project.measures.map((m) => {
    const value = p.measure(m.name, null);
    return { name: m.name, value, note: value === null ? 'Calculated in Power BI only' : undefined };
  });
}

const MAX_CATEGORIES = 12;

export function reportPreview(project: Project, report: ReportSpec): PreviewData {
  const out: PreviewData = { measures: {}, visuals: {} };
  if (!project.model) return out;
  const model = project.model;
  const p = new Previewer(project, model, project.measures);
  for (const m of project.measures) out.measures[m.name] = p.measure(m.name, null);

  for (const v of report.visuals) {
    if (v.type === 'card' || v.type === 'multiRowCard' || v.type === 'slicer') continue;
    const cat = v.fields.find((f) => categoryRoles(v.type).includes(f.role) && f.field.kind === 'column');
    const vals = v.fields.filter((f) => valueRoles(v.type).includes(f.role) && f.field.kind === 'measure');
    if (!cat || !vals.length) continue;
    const isDate = model.dateTable.enabled && cat.field.table === model.dateTable.name;
    let cats = p.categoryValues(cat.field.table, cat.field.name);
    if (isDate && cat.field.name === 'Month') cats = MONTHS.filter((mm) => cats.includes(mm));
    else if (isDate) cats.sort((a, b) => (String(a) < String(b) ? -1 : 1));
    if (cats.length > 200) cats = cats.slice(0, 200);
    let series = cats.map((c) => ({
      category: String(c),
      values: Object.fromEntries(
        vals.map((f) => [f.field.name, p.measure(f.field.name, { table: cat.field.table, column: cat.field.name, value: String(c) })]),
      ),
    }));
    const order = isDate ? null : p.sortOrder(cat.field.table, cat.field.name);
    if (order) {
      series.sort((a, b) => (order.get(a.category.toLowerCase()) ?? 99) - (order.get(b.category.toLowerCase()) ?? 99));
    } else if (!isDate) {
      const first = vals[0].field.name;
      series.sort((a, b) => (b.values[first] ?? -Infinity) - (a.values[first] ?? -Infinity));
      series = series.slice(0, MAX_CATEGORIES);
    } else if (series.length > 36) {
      series = series.slice(-36);
    }
    out.visuals[v.id] = series;
  }
  return out;
}
