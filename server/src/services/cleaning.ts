import type {
  AddColumnSpec,
  Cell,
  CleanedColumn,
  CleaningOp,
  CleaningResult,
  ColumnType,
  Culture,
  FilterOperator,
  SourceTable,
  TableCleaning,
} from '../../../shared/types.js';
import type { RawTable } from './ingest.js';
import { StepNamer, mField, mLet, mList, mLiteral, mString, mStringList, mType } from './m.js';
import { convertValue, inferType, isBlank, parseDate, parseNumber } from './values.js';
import { cleaningOpSchema } from './schemas.js';

// Every cleaning operation has two faces:
//   apply()  – runs in JS for the live preview and validation totals
//   toM()    – emits the equivalent Power Query step
// Both must stay in sync; tests in cleaning.test.ts pin the M output.

export interface PipelineState {
  headers: string[];
  rows: Cell[][];
  types: Map<string, ColumnType>;
  culture: Culture;
  /** Power BI column properties produced by steps (sort-by, hidden). */
  meta: Map<string, { sortBy?: string; hidden?: boolean }>;
  ctx: PipelineContext;
}

/** Access to other cleaned tables (for merges). */
export interface PipelineContext {
  resolve(table: string): { headers: string[]; rows: Cell[][]; columns: CleanedColumn[] } | null;
}

export const NO_CONTEXT: PipelineContext = { resolve: () => null };

export const sortName = (column: string) => `${column} Sort`;

/** Name of the (not loaded) query holding a table's cleaned data, used by merges and shared sources. */
export function stagingName(source: string) {
  return `${source} Base`;
}

/** Round half away from zero, like Number.Round(x, d, RoundingMode.AwayFromZero). */
export function roundAway(x: number, d: number) {
  const f = 10 ** d;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

type OpOf<K extends CleaningOp['op']> = Extract<CleaningOp, { op: K }>;

interface OpImpl<K extends CleaningOp['op']> {
  columns(op: OpOf<K>): string[];
  title(op: OpOf<K>): string;
  apply(s: PipelineState, op: OpOf<K>): string | void;
  toM(prev: string, op: OpOf<K>, s: PipelineState): string;
}

const NUMERIC: ColumnType[] = ['number', 'integer', 'currency'];

function idx(s: PipelineState, col: string) {
  return s.headers.indexOf(col);
}

function mapColumns(s: PipelineState, cols: string[], fn: (v: Cell) => Cell) {
  const ids = cols.map((c) => idx(s, c));
  for (const row of s.rows) for (const i of ids) row[i] = fn(row[i]);
}

function textTransform(fn: (s: string) => string) {
  return (v: Cell) => (typeof v === 'string' ? fn(v) : v);
}

function textM(prev: string, cols: string[], mFn: string) {
  const list = cols.map((c) => `{${mString(c)}, each if _ is text then ${mFn}(_) else _}`);
  return `Table.TransformColumns(${prev}, ${mList(list)})`;
}

export function properCase(s: string) {
  return s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

function list(cols: string[]) {
  return cols.length > 3 ? `${cols.slice(0, 3).join(', ')} +${cols.length - 3}` : cols.join(', ');
}

// ---------- comparisons shared by filterRows / conditional columns ----------

function coerceForCompare(value: unknown, type: ColumnType | undefined, culture: Culture): Cell {
  if (value === null || value === undefined) return null;
  if (type && NUMERIC.includes(type)) return parseNumber(value as Cell);
  if (type === 'date' || type === 'datetime') return convertValue(String(value), type, culture);
  return value as Cell;
}

export function compare(v: Cell, operator: FilterOperator, target: Cell): boolean {
  if (operator === 'isNotBlank') return v !== null && v !== '';
  if (v === null || target === null) return operator === 'notEquals' ? v !== target : false;
  if (operator === 'contains' || operator === 'notContains') {
    if (typeof v !== 'string') return false;
    const has = v.includes(String(target));
    return operator === 'contains' ? has : !has;
  }
  if (typeof v !== typeof target) return operator === 'notEquals';
  switch (operator) {
    case 'equals':
      return v === target;
    case 'notEquals':
      return v !== target;
    case 'greaterThan':
      return v > target;
    case 'lessThan':
      return v < target;
    case 'greaterOrEqual':
      return v >= target;
    case 'lessOrEqual':
      return v <= target;
  }
  return false;
}

function predicateM(col: string, operator: FilterOperator, value: unknown, s: PipelineState): string {
  const f = mField(col);
  const lit = mLiteral(value, s.types.get(col), s.culture);
  switch (operator) {
    case 'isNotBlank':
      return `${f} <> null and ${f} <> ""`;
    case 'contains':
      return `try Text.Contains(${f}, ${mString(String(value ?? ''))}) otherwise false`;
    case 'notContains':
      return `try not Text.Contains(${f}, ${mString(String(value ?? ''))}) otherwise false`;
    case 'equals':
      return `try (${f} = ${lit}) = true otherwise false`;
    case 'notEquals':
      return `try (${f} <> ${lit}) = true otherwise false`;
    case 'greaterThan':
      return `try (${f} > ${lit}) = true otherwise false`;
    case 'lessThan':
      return `try (${f} < ${lit}) = true otherwise false`;
    case 'greaterOrEqual':
      return `try (${f} >= ${lit}) = true otherwise false`;
    case 'lessOrEqual':
      return `try (${f} <= ${lit}) = true otherwise false`;
  }
}

const OP_LABEL: Record<FilterOperator, string> = {
  equals: '=',
  notEquals: '<>',
  greaterThan: '>',
  lessThan: '<',
  greaterOrEqual: '>=',
  lessOrEqual: '<=',
  contains: 'contains',
  notContains: 'does not contain',
  isNotBlank: 'is not blank',
};

// ---------- added columns ----------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));

function numericType(values: unknown[]): ColumnType {
  return values.every((v) => Number.isInteger(Number(v))) ? 'integer' : 'number';
}

function addColumnType(spec: AddColumnSpec): ColumnType {
  switch (spec.kind) {
    case 'arithmetic':
    case 'sum':
      return 'number';
    case 'datePart':
      return spec.part === 'monthName' || spec.part === 'weekdayName' || spec.part === 'yearMonth' ? 'text' : 'integer';
    case 'cases': {
      const outs = [...spec.cases.map((c) => c.then), spec.else];
      return outs.every((v) => typeof v === 'number') ? numericType(outs) : 'text';
    }
    case 'bucket':
      return spec.numeric && spec.labels.every(isNum) ? numericType(spec.labels) : 'text';
    case 'concat':
    case 'conditional':
      return 'text';
    case 'custom':
      return spec.type;
  }
}

function addColumnRefs(spec: AddColumnSpec): string[] {
  switch (spec.kind) {
    case 'arithmetic':
      return typeof spec.right === 'string' ? [spec.left, spec.right] : [spec.left];
    case 'datePart':
    case 'conditional':
    case 'bucket':
      return [spec.column];
    case 'concat':
    case 'sum':
      return spec.columns;
    case 'cases':
      return [...new Set(spec.cases.map((c) => c.column))];
    case 'custom':
      return [];
  }
}

function toNum(v: Cell): number | null {
  return typeof v === 'number' ? v : parseNumber(v);
}

/** Index of the band a value falls in: v <= bounds[i] → i, above all bounds → bounds.length. */
export function bucketIndex(v: number | null, bounds: number[]): number | null {
  if (v === null) return null;
  const i = bounds.findIndex((b) => v <= b);
  return i < 0 ? bounds.length : i;
}

function bucketM(spec: Extract<AddColumnSpec, { kind: 'bucket' }>, s: PipelineState, out: (i: number) => string) {
  const chain = spec.bounds.map((b, i) => `if v <= ${b} then ${out(i)} else `).join('');
  return `each let v = try Number.From(${mField(spec.column)}, ${mString(s.culture)}) otherwise null in if v = null then null else ${chain}${out(spec.bounds.length)}`;
}

function addColumnValue(spec: AddColumnSpec, s: PipelineState): (row: Cell[]) => Cell {
  switch (spec.kind) {
    case 'arithmetic': {
      const li = idx(s, spec.left);
      const ri = typeof spec.right === 'string' ? idx(s, spec.right) : -1;
      const calc = (a: number, b: number) => {
        switch (spec.operator) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            return b === 0 ? null : a / b;
        }
      };
      return (row) => {
        const a = toNum(row[li]);
        const b = ri >= 0 ? toNum(row[ri]) : (spec.right as number);
        if (a === null || b === null) return null;
        let r = calc(a, b);
        if (r === null) return null;
        if (spec.scale !== undefined) r *= spec.scale;
        return spec.round !== undefined ? roundAway(r, spec.round) : r;
      };
    }
    case 'datePart': {
      const ci = idx(s, spec.column);
      return (row) => {
        const v = row[ci];
        const d = typeof v === 'string' ? parseDate(v, s.culture) : null;
        if (!d) return null;
        const [y, m, day] = d.slice(0, 10).split('-').map(Number);
        switch (spec.part) {
          case 'year':
            return y;
          case 'month':
            return m;
          case 'monthName':
            return MONTH_NAMES[m - 1];
          case 'quarter':
            return Math.ceil(m / 3);
          case 'day':
            return day;
          case 'weekdayName':
            return DAY_NAMES[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
          case 'yearMonth':
            return `${y}-${String(m).padStart(2, '0')}`;
          case 'age': {
            const now = new Date();
            const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
            return Math.floor((today - Date.UTC(y, m - 1, day)) / 86400000 / 365.25);
          }
        }
      };
    }
    case 'bucket': {
      const ci = idx(s, spec.column);
      const numeric = addColumnType(spec) !== 'text';
      return (row) => {
        const i = bucketIndex(toNum(row[ci]), spec.bounds);
        if (i === null) return null;
        return numeric ? Number(spec.labels[i]) : String(spec.labels[i]);
      };
    }
    case 'sum': {
      const ids = spec.columns.map((c) => idx(s, c));
      return (row) => ids.reduce((acc, i) => acc + (toNum(row[i]) ?? 0), 0);
    }
    case 'cases': {
      const rules = spec.cases.map((c) => ({ ...c, ci: idx(s, c.column), target: coerceForCompare(c.value, s.types.get(c.column), s.culture) }));
      return (row) => {
        for (const r of rules) if (compare(row[r.ci], r.operator, r.target)) return r.then;
        return spec.else;
      };
    }
    case 'concat': {
      const ids = spec.columns.map((c) => idx(s, c));
      return (row) => {
        const parts = ids.map((i) => row[i]).filter((v) => v !== null).map(String);
        return parts.length ? parts.join(spec.separator) : null;
      };
    }
    case 'conditional': {
      const ci = idx(s, spec.column);
      const target = coerceForCompare(spec.value, s.types.get(spec.column), s.culture);
      return (row) => (compare(row[ci], spec.operator, target) ? spec.then : spec.else);
    }
    case 'custom':
      return () => null;
  }
}

function addColumnM(spec: AddColumnSpec, s: PipelineState): string {
  switch (spec.kind) {
    case 'arithmetic': {
      const num = (col: string) => `Number.From(${mField(col)}, ${mString(s.culture)})`;
      const a = num(spec.left);
      const b = typeof spec.right === 'string' ? num(spec.right) : String(spec.right);
      let expr = spec.operator === '/' ? `(if b = 0 then null else a / b)` : `(a ${spec.operator} b)`;
      if (spec.scale !== undefined) expr = `${expr} * ${spec.scale}`;
      if (spec.round !== undefined) expr = `Number.Round(${expr}, ${spec.round}, RoundingMode.AwayFromZero)`;
      return `each try (let a = ${a}, b = ${b} in if a = null or b = null then null else ${expr}) otherwise null`;
    }
    case 'datePart': {
      const d = `Date.From(${mField(spec.column)}, ${mString(s.culture)})`;
      const fn: Record<string, string> = {
        year: `Date.Year(d)`,
        month: `Date.Month(d)`,
        monthName: `Date.MonthName(d, "en-US")`,
        quarter: `Date.QuarterOfYear(d)`,
        day: `Date.Day(d)`,
        weekdayName: `Date.DayOfWeekName(d, "en-US")`,
        yearMonth: `Date.ToText(d, "yyyy-MM")`,
        age: `Number.RoundDown(Duration.Days(Date.From(DateTime.LocalNow()) - d) / 365.25)`,
      };
      return `each try (let d = ${d} in if d = null then null else ${fn[spec.part]}) otherwise null`;
    }
    case 'bucket': {
      const numeric = addColumnType(spec) !== 'text';
      return bucketM(spec, s, (i) => (numeric ? String(Number(spec.labels[i])) : mString(String(spec.labels[i]))));
    }
    case 'sum': {
      const items = spec.columns.map((c) => `let n = try Number.From(${mField(c)}, ${mString(s.culture)}) otherwise null in if n = null then 0 else n`);
      return `each List.Sum({${items.map((i) => `(${i})`).join(', ')}})`;
    }
    case 'cases': {
      const lit = (v: string | number) => (typeof v === 'number' ? String(v) : mString(v));
      const chain = spec.cases.map((c) => `if (${predicateM(c.column, c.operator, c.value, s)}) then ${lit(c.then)} else `).join('');
      return `each ${chain}${lit(spec.else)}`;
    }
    case 'concat': {
      const items = spec.columns.map((c) => `if ${mField(c)} = null then null else Text.From(${mField(c)})`);
      return `each let parts = List.RemoveNulls(${mList(items)}) in if List.IsEmpty(parts) then null else Text.Combine(parts, ${mString(spec.separator)})`;
    }
    case 'conditional':
      return `each if (${predicateM(spec.column, spec.operator, spec.value, s)}) then ${mString(spec.then)} else ${mString(spec.else)}`;
    case 'custom': {
      const e = spec.mExpression.trim();
      return e.startsWith('each') ? e : `each ${e}`;
    }
  }
}

// ---------- merges ----------

function mergeTarget(s: PipelineState, op: Extract<CleaningOp, { op: 'mergeTable' }>) {
  const other = s.ctx.resolve(op.table);
  if (!other) throw new Error(`Table "${op.table}" not found (or it merges this table back — circular merge)`);
  const ri = other.headers.indexOf(op.rightKey);
  if (ri < 0) throw new Error(`Column "${op.rightKey}" not found in "${op.table}"`);
  const cols = op.columns?.length ? op.columns : other.headers.filter((h) => h !== op.rightKey && !s.headers.includes(h));
  const missing = cols.filter((c) => !other.headers.includes(c));
  if (missing.length) throw new Error(`Column(s) not found in "${op.table}": ${missing.join(', ')}`);
  const clash = cols.filter((c) => s.headers.includes(c));
  if (clash.length) throw new Error(`Column(s) already exist: ${clash.join(', ')} — rename them first`);
  if (!cols.length) throw new Error(`Nothing to merge from "${op.table}"`);
  return { other, cols, ri };
}

// ---------- the op library ----------

const OPS: { [K in CleaningOp['op']]: OpImpl<K> } = {
  setType: {
    columns: (op) => [op.column],
    title: (op) => `Changed Type ${op.column}`,
    apply(s, op) {
      const i = idx(s, op.column);
      let failed = 0;
      for (const row of s.rows) {
        const before = row[i];
        row[i] = convertValue(before, op.type, s.culture);
        if (row[i] === null && !isBlank(before)) failed++;
      }
      s.types.set(op.column, op.type);
      if (failed) return `${failed} values could not be converted to ${op.type} and became null`;
    },
    toM: (prev, op, s) =>
      `Table.ReplaceErrorValues(Table.TransformColumnTypes(${prev}, {{${mString(op.column)}, ${mType(op.type)}}}, ${mString(s.culture)}), {{${mString(op.column)}, null}})`,
  },
  trim: {
    columns: (op) => op.columns,
    title: (op) => `Trimmed ${list(op.columns)}`,
    apply: (s, op) => mapColumns(s, op.columns, textTransform((v) => v.trim())),
    toM: (prev, op) => textM(prev, op.columns, 'Text.Trim'),
  },
  clean: {
    columns: (op) => op.columns,
    title: (op) => `Cleaned ${list(op.columns)}`,
    // eslint-disable-next-line no-control-regex
    apply: (s, op) => mapColumns(s, op.columns, textTransform((v) => v.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''))),
    toM: (prev, op) => textM(prev, op.columns, 'Text.Clean'),
  },
  properCase: {
    columns: (op) => op.columns,
    title: (op) => `Capitalized ${list(op.columns)}`,
    apply: (s, op) => mapColumns(s, op.columns, textTransform(properCase)),
    toM: (prev, op) => textM(prev, op.columns, 'Text.Proper'),
  },
  upperCase: {
    columns: (op) => op.columns,
    title: (op) => `Uppercased ${list(op.columns)}`,
    apply: (s, op) => mapColumns(s, op.columns, textTransform((v) => v.toUpperCase())),
    toM: (prev, op) => textM(prev, op.columns, 'Text.Upper'),
  },
  lowerCase: {
    columns: (op) => op.columns,
    title: (op) => `Lowercased ${list(op.columns)}`,
    apply: (s, op) => mapColumns(s, op.columns, textTransform((v) => v.toLowerCase())),
    toM: (prev, op) => textM(prev, op.columns, 'Text.Lower'),
  },
  emptyToNull: {
    columns: (op) => op.columns,
    title: (op) => `Blanks to Null ${list(op.columns)}`,
    apply: (s, op) => mapColumns(s, op.columns, (v) => (v === '' ? null : v)),
    toM: (prev, op) => `Table.ReplaceValue(${prev}, "", null, Replacer.ReplaceValue, ${mStringList(op.columns)})`,
  },
  replaceValues: {
    columns: (op) => [op.column],
    title: (op) => `Replaced ${op.find === null ? 'null' : `"${op.find}"`} in ${op.column}`,
    apply(s, op) {
      const i = idx(s, op.column);
      let n = 0;
      for (const row of s.rows) {
        const v = row[i];
        if (op.wholeValue) {
          if (v === op.find) {
            row[i] = op.replace;
            n++;
          }
        } else if (typeof v === 'string' && op.find !== null && op.find !== '' && v.includes(String(op.find))) {
          row[i] = v.split(String(op.find)).join(op.replace === null ? '' : String(op.replace));
          n++;
        }
      }
      return `${n} values changed`;
    },
    toM(prev, op) {
      const lit = (v: string | number | null) => (v === null ? 'null' : typeof v === 'number' ? String(v) : mString(v));
      if (op.wholeValue) {
        return `Table.ReplaceValue(${prev}, ${lit(op.find)}, ${lit(op.replace)}, Replacer.ReplaceValue, {${mString(op.column)}})`;
      }
      const repl = op.replace === null ? '""' : mString(String(op.replace));
      return `Table.ReplaceValue(${prev}, ${mString(String(op.find ?? ''))}, ${repl}, Replacer.ReplaceText, {${mString(op.column)}})`;
    },
  },
  replaceNulls: {
    columns: (op) => [op.column],
    title: (op) => `Filled Nulls in ${op.column}`,
    apply: (s, op) => mapColumns(s, [op.column], (v) => (v === null ? op.value : v)),
    toM: (prev, op) =>
      `Table.ReplaceValue(${prev}, null, ${typeof op.value === 'number' ? op.value : mString(op.value)}, Replacer.ReplaceValue, {${mString(op.column)}})`,
  },
  removeDuplicates: {
    columns: (op) => op.columns ?? [],
    title: (op) => (op.columns?.length ? `Removed Duplicate ${list(op.columns)}` : 'Removed Duplicate Rows'),
    apply(s, op) {
      const ids = op.columns?.length ? op.columns.map((c) => idx(s, c)) : null;
      const seen = new Set<string>();
      const before = s.rows.length;
      s.rows = s.rows.filter((row) => {
        const key = JSON.stringify(ids ? ids.map((i) => row[i]) : row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return `${before - s.rows.length} duplicate rows removed`;
    },
    toM: (prev, op) => (op.columns?.length ? `Table.Distinct(${prev}, ${mStringList(op.columns)})` : `Table.Distinct(${prev})`),
  },
  removeBlankRows: {
    columns: () => [],
    title: () => 'Removed Blank Rows',
    apply(s) {
      const before = s.rows.length;
      s.rows = s.rows.filter((row) => !row.every((v) => v === null || v === ''));
      return `${before - s.rows.length} blank rows removed`;
    },
    toM: (prev) =>
      `Table.SelectRows(${prev}, each not List.IsEmpty(List.RemoveMatchingItems(Record.FieldValues(_), {"", null})))`,
  },
  removeRowsWithBlank: {
    columns: (op) => [op.column],
    title: (op) => `Removed Rows With Blank ${op.column}`,
    apply(s, op) {
      const i = idx(s, op.column);
      const before = s.rows.length;
      s.rows = s.rows.filter((row) => row[i] !== null && row[i] !== '');
      return `${before - s.rows.length} rows removed`;
    },
    toM: (prev, op) => `Table.SelectRows(${prev}, each ${mField(op.column)} <> null and ${mField(op.column)} <> "")`,
  },
  fillDown: {
    columns: (op) => op.columns,
    title: (op) => `Filled Down ${list(op.columns)}`,
    apply(s, op) {
      for (const c of op.columns) {
        const i = idx(s, c);
        let last: Cell = null;
        for (const row of s.rows) {
          if (row[i] === null) row[i] = last;
          else last = row[i];
        }
      }
    },
    toM: (prev, op) => `Table.FillDown(${prev}, ${mStringList(op.columns)})`,
  },
  splitColumn: {
    columns: (op) => [op.column],
    title: (op) => `Split ${op.column}`,
    apply(s, op) {
      const i = idx(s, op.column);
      const n = op.newColumns.length;
      s.headers.splice(i, 1, ...op.newColumns);
      s.rows = s.rows.map((row) => {
        const v = row[i];
        const parts: Cell[] = typeof v === 'string' ? v.split(op.delimiter) : [v];
        const out = Array.from({ length: n }, (_, k) => (parts[k] === undefined ? null : parts[k]));
        const copy = row.slice();
        copy.splice(i, 1, ...out);
        return copy;
      });
      s.types.delete(op.column);
      for (const c of op.newColumns) s.types.set(c, 'text');
    },
    toM: (prev, op) =>
      `Table.SplitColumn(${prev}, ${mString(op.column)}, Splitter.SplitTextByDelimiter(${mString(op.delimiter)}, QuoteStyle.None), ${mStringList(op.newColumns)})`,
  },
  addColumn: {
    columns: (op) => addColumnRefs(op.spec),
    title: (op) => `Added ${op.name}`,
    apply(s, op) {
      if (s.headers.includes(op.name)) throw new Error(`Column "${op.name}" already exists`);
      const spec = op.spec;
      const textBands = spec.kind === 'bucket' && addColumnType(spec) === 'text';
      if (spec.kind === 'bucket') {
        if (spec.labels.length !== spec.bounds.length + 1) throw new Error('A bucket needs exactly one more label than bounds');
        if (textBands && s.headers.includes(sortName(op.name))) throw new Error(`Column "${sortName(op.name)}" already exists`);
      }
      const fn = addColumnValue(spec, s);
      s.rows = s.rows.map((row) => [...row, fn(row)]);
      s.headers.push(op.name);
      s.types.set(op.name, addColumnType(spec));
      if (spec.kind === 'bucket' && textBands) {
        // Hidden order column so the bands sort 0-30, 31-60, … not alphabetically.
        const ci = idx(s, spec.column);
        s.rows = s.rows.map((row) => {
          const i = bucketIndex(toNum(row[ci]), spec.bounds);
          return [...row, i === null ? null : i + 1];
        });
        s.headers.push(sortName(op.name));
        s.types.set(sortName(op.name), 'integer');
        s.meta.set(op.name, { sortBy: sortName(op.name) });
        s.meta.set(sortName(op.name), { hidden: true });
      }
      if (spec.kind === 'custom') return 'Custom M column: values are only computed in Power BI (preview shows blanks)';
    },
    toM(prev, op, s) {
      const added = `Table.AddColumn(${prev}, ${mString(op.name)}, ${addColumnM(op.spec, s)}, ${mType(addColumnType(op.spec))})`;
      const spec = op.spec;
      if (spec.kind !== 'bucket' || addColumnType(spec) !== 'text') return added;
      return `Table.AddColumn(${added}, ${mString(sortName(op.name))}, ${bucketM(spec, s, (i) => String(i + 1))}, Int64.Type)`;
    },
  },
  rename: {
    columns: (op) => [op.from],
    title: (op) => `Renamed ${op.from}`,
    apply(s, op) {
      if (s.headers.includes(op.to)) throw new Error(`Column "${op.to}" already exists`);
      s.headers[idx(s, op.from)] = op.to;
      const t = s.types.get(op.from);
      s.types.delete(op.from);
      if (t) s.types.set(op.to, t);
      const m = s.meta.get(op.from);
      s.meta.delete(op.from);
      if (m) s.meta.set(op.to, m);
      for (const v of s.meta.values()) if (v.sortBy === op.from) v.sortBy = op.to;
    },
    toM: (prev, op) => `Table.RenameColumns(${prev}, {{${mString(op.from)}, ${mString(op.to)}}})`,
  },
  removeColumns: {
    columns: (op) => op.columns,
    title: (op) => `Removed ${list(op.columns)}`,
    apply(s, op) {
      const drop = new Set(op.columns.map((c) => idx(s, c)));
      s.headers = s.headers.filter((_, i) => !drop.has(i));
      s.rows = s.rows.map((row) => row.filter((_, i) => !drop.has(i)));
      for (const c of op.columns) {
        s.types.delete(c);
        s.meta.delete(c);
      }
    },
    toM: (prev, op) => `Table.RemoveColumns(${prev}, ${mStringList(op.columns)}, MissingField.Ignore)`,
  },
  addRank: {
    columns: (op) => [op.column],
    title: (op) => `Ranked by ${op.column}`,
    apply(s, op) {
      if (s.headers.includes(op.name)) throw new Error(`Column "${op.name}" already exists`);
      const ci = idx(s, op.column);
      const values = s.rows.map((r) => toNum(r[ci]));
      // Competition ranking ("1, 2, 2, 4"), like RankKind.Competition; blanks rank last.
      const sorted = values.filter((v): v is number => v !== null).sort((a, b) => (op.descending ? b - a : a - b));
      const first = new Map<number, number>();
      sorted.forEach((v, i) => {
        if (!first.has(v)) first.set(v, i + 1);
      });
      s.rows = s.rows.map((r, i) => [...r, values[i] === null ? sorted.length + 1 : first.get(values[i] as number)!]);
      s.headers.push(op.name);
      s.types.set(op.name, 'integer');
    },
    toM: (prev, op) =>
      `Table.AddRankColumn(${prev}, ${mString(op.name)}, {{${mString(op.column)}, Order.${op.descending ? 'Descending' : 'Ascending'}}}, [RankKind = RankKind.Competition])`,
  },
  mergeTable: {
    columns: (op) => [op.leftKey],
    title: (op) => `Merged ${op.table}`,
    apply(s, op) {
      const { other, cols, ri } = mergeTarget(s, op);
      const index = new Map<string, Cell[][]>();
      for (const r of other.rows) {
        const key = JSON.stringify(r[ri]);
        if (r[ri] === null) continue;
        (index.get(key) ?? index.set(key, []).get(key)!).push(r);
      }
      const ids = cols.map((c) => other.headers.indexOf(c));
      const li = idx(s, op.leftKey);
      const empty = ids.map(() => null);
      const out: Cell[][] = [];
      let unmatched = 0;
      for (const row of s.rows) {
        const matches = row[li] === null ? undefined : index.get(JSON.stringify(row[li]));
        if (!matches) {
          unmatched++;
          out.push([...row, ...empty]);
        } else for (const m of matches) out.push([...row, ...ids.map((i) => m[i])]);
      }
      const before = s.rows.length;
      s.rows = out;
      s.headers.push(...cols);
      for (const c of cols) {
        const oc = other.columns.find((x) => x.name === c);
        if (oc) s.types.set(c, oc.type);
        if (oc?.sortBy && cols.includes(oc.sortBy)) s.meta.set(c, { sortBy: oc.sortBy });
        if (oc?.hidden) s.meta.set(c, { hidden: true });
      }
      const notes = [`${cols.length} columns added`];
      if (unmatched) notes.push(`${unmatched} rows had no match`);
      if (out.length !== before) notes.push(`row count changed ${before} → ${out.length} (duplicate keys in ${op.table})`);
      return notes.join('; ');
    },
    toM(prev, op, s) {
      const { cols } = mergeTarget(s, op);
      return `Table.ExpandTableColumn(Table.NestedJoin(${prev}, {${mString(op.leftKey)}}, #${mString(stagingName(op.table))}, {${mString(op.rightKey)}}, "__Merged", JoinKind.LeftOuter), "__Merged", ${mStringList(cols)}, ${mStringList(cols)})`;
    },
  },
  filterRows: {
    columns: (op) => [op.column],
    title: (op) => `Filtered ${op.column} ${OP_LABEL[op.operator]}${op.value !== undefined && op.operator !== 'isNotBlank' ? ` ${op.value}` : ''}`,
    apply(s, op) {
      const i = idx(s, op.column);
      const target = coerceForCompare(op.value, s.types.get(op.column), s.culture);
      const before = s.rows.length;
      s.rows = s.rows.filter((row) => compare(row[i], op.operator, target));
      return `${before - s.rows.length} rows removed`;
    },
    toM: (prev, op, s) => `Table.SelectRows(${prev}, each ${predicateM(op.column, op.operator, op.value, s)})`,
  },
};

export const OP_KINDS = Object.keys(OPS) as CleaningOp['op'][];

function impl(op: CleaningOp): OpImpl<CleaningOp['op']> {
  const found = OPS[op.op] as OpImpl<CleaningOp['op']> | undefined;
  if (!found) throw new Error(`Unknown operation "${op.op}"`);
  return found;
}

export function defaultTitle(op: CleaningOp) {
  return impl(op).title(op as never);
}

// ---------- source step ----------

export function sourceSteps(table: SourceTable): { name: string; expr: string }[] {
  if (table.kind === 'sql' && table.sql) {
    // Live SQL Server source: Power BI runs the query itself on refresh.
    const s = table.sql;
    return [{ name: 'Source', expr: `Sql.Database(${mString(s.server)}, ${mString(s.database)}, [Query=${mString(s.query)}])` }];
  }
  const file = `DataFolder & ${mString(table.file)}`;
  if (table.kind === 'excel') {
    return [
      { name: 'Source', expr: `Excel.Workbook(File.Contents(${file}), null, true)` },
      { name: 'Sheet', expr: `#"Source"{[Item=${mString(table.sheet ?? '')}, Kind="Sheet"]}[Data]` },
      { name: 'Promoted Headers', expr: `Table.PromoteHeaders(#"Sheet", [PromoteAllScalars=true])` },
    ];
  }
  const delim = table.delimiter === '\t' ? '"#(tab)"' : mString(table.delimiter ?? ',');
  return [
    { name: 'Source', expr: `Csv.Document(File.Contents(${file}), [Delimiter=${delim}, Encoding=65001, QuoteStyle=QuoteStyle.Csv])` },
    { name: 'Promoted Headers', expr: `Table.PromoteHeaders(#"Source", [PromoteAllScalars=true])` },
  ];
}

// ---------- pipeline ----------

const PREVIEW_ROWS = 200;

function preview(headers: string[], rows: Cell[][]) {
  return { headers: [...headers], rows: rows.slice(0, PREVIEW_ROWS).map((r) => [...r]) };
}

export interface PipelineOutput extends CleaningResult {
  headers: string[];
  rows: Cell[][];
  steps: { name: string; expr: string }[];
  /** How many leading steps read the source (replaced when the data is embedded). */
  sourceStepCount: number;
}

export function runPipeline(table: SourceTable, raw: RawTable, cleaning: TableCleaning, ctx: PipelineContext = NO_CONTEXT): PipelineOutput {
  const s: PipelineState = {
    headers: [...raw.headers],
    rows: raw.rows.map((r) => [...r]),
    types: new Map(),
    culture: cleaning.culture,
    meta: new Map(),
    ctx,
  };
  const rowsBefore = s.rows.length;
  const previewBefore = preview(s.headers, s.rows);
  const namer = new StepNamer();
  const steps = sourceSteps(table).map((st) => ({ name: namer.name(st.name), expr: st.expr }));
  const stepStats: CleaningResult['stepStats'] = [];
  const warnings: string[] = [];

  for (const op of cleaning.ops) {
    if (!op.enabled) continue;
    // Steps being edited in the UI can be incomplete — skip them, don't fail.
    const check = cleaningOpSchema.safeParse(op);
    if (!check.success) {
      const issue = check.error.issues[0];
      warnings.push(`Skipped step ${cleaning.ops.indexOf(op) + 1} (${op.op}): ${issue.path.join('.') || 'settings'} — ${issue.message}`);
      continue;
    }
    const im = impl(op);
    const title = op.title?.trim() || im.title(op as never);
    const missing = im.columns(op as never).filter((c) => !s.headers.includes(c));
    if (missing.length) {
      warnings.push(`Skipped "${title}": column(s) not found: ${missing.join(', ')}`);
      continue;
    }
    const prev = steps[steps.length - 1].name;
    // Generate M against the state *before* the op runs (types, culture).
    let expr: string;
    let note: string | void;
    try {
      expr = im.toM(`#${mString(prev)}`, op as never, s);
      const snapshot = { headers: [...s.headers], rows: s.rows, types: new Map(s.types), meta: new Map(s.meta), ctx: s.ctx };
      try {
        note = im.apply(s, op as never);
      } catch (e) {
        Object.assign(s, snapshot);
        throw e;
      }
    } catch (e) {
      warnings.push(`Skipped "${title}": ${(e as Error).message}`);
      continue;
    }
    const name = namer.name(title);
    steps.push({ name, expr });
    stepStats.push({ id: op.id, title: name, rowsAfter: s.rows.length, note: note || undefined });
  }

  // Final, explicit types for every column (what Power BI will load).
  const columns: CleanedColumn[] = s.headers.map((h, i) => {
    const type =
      cleaning.finalTypes?.[h] ??
      s.types.get(h) ??
      inferType(
        h,
        s.rows.map((r) => r[i]),
        s.culture,
      );
    const meta = s.meta.get(h);
    const sortBy = meta?.sortBy && s.headers.includes(meta.sortBy) ? meta.sortBy : undefined;
    return { name: h, type, ...(sortBy ? { sortBy } : {}), ...(meta?.hidden ? { hidden: true } : {}) };
  });
  s.rows = s.rows.map((row) => row.map((v, i) => convertValue(v, columns[i].type, s.culture)));
  const prev = `#${mString(steps[steps.length - 1].name)}`;
  if (columns.length) {
    const typeList = columns.map((c) => `{${mString(c.name)}, ${mType(c.type)}}`);
    steps.push({ name: namer.name('Set Final Types'), expr: `Table.TransformColumnTypes(${prev}, ${mList(typeList)}, ${mString(s.culture)})` });
    const nonText = columns.filter((c) => c.type !== 'text').map((c) => `{${mString(c.name)}, null}`);
    if (nonText.length) {
      steps.push({
        name: namer.name('Replaced Conversion Errors'),
        expr: `Table.ReplaceErrorValues(#${mString(steps[steps.length - 1].name)}, ${mList(nonText)})`,
      });
    }
  }

  return {
    table: table.name,
    rowsBefore,
    sourceStepCount: sourceSteps(table).length,
    rowsAfter: s.rows.length,
    columns,
    previewBefore,
    previewAfter: preview(s.headers, s.rows),
    stepStats,
    warnings,
    m: mLet(steps),
    headers: s.headers,
    rows: s.rows,
    steps,
  };
}
