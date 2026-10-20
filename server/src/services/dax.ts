import type { Cell, CleanedColumn, LintIssue, MeasureSpec, ModelSpec } from '../../../shared/types.js';

export function daxTable(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

export function daxColumn(table: string, column: string) {
  return `${daxTable(table)}[${column.replace(/\]/g, ']]')}]`;
}

export function daxMeasureRef(name: string) {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/** Remove string literals and comments so structural checks are not fooled. */
function stripLiterals(expr: string) {
  return expr
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\/\/[^\n]*|--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Ref {
  table?: string;
  name: string;
}

const REF_RE = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))?\[((?:[^\]]|\]\])+)\]/g;

function findRefs(expr: string): Ref[] {
  const refs: Ref[] = [];
  const clean = stripLiterals(expr);
  for (const m of clean.matchAll(REF_RE)) {
    const table = (m[1] ?? m[2])?.replace(/''/g, "'");
    refs.push({ table, name: m[3].replace(/\]\]/g, ']') });
  }
  return refs;
}

export function lintMeasures(
  measures: MeasureSpec[],
  tables: Map<string, CleanedColumn[]>,
  measureTable: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const names = new Map<string, number>();
  for (const m of measures) names.set(m.name.toLowerCase(), (names.get(m.name.toLowerCase()) ?? 0) + 1);
  const measureNames = new Set(measures.map((m) => m.name.toLowerCase()));
  const allColumns = new Set([...tables.values()].flat().map((c) => c.name.toLowerCase()));
  const tableNames = new Map([...tables.keys()].map((t) => [t.toLowerCase(), t]));

  for (const m of measures) {
    const add = (level: LintIssue['level'], message: string) => issues.push({ measure: m.name, level, message });
    if (!m.name.trim()) add('error', 'Measure name is empty');
    if (/[[\]]/.test(m.name)) add('error', 'Measure name cannot contain [ or ]');
    if ((names.get(m.name.toLowerCase()) ?? 0) > 1) add('error', 'Duplicate measure name');
    if (allColumns.has(m.name.toLowerCase())) add('error', `Name "${m.name}" is already used by a column — rename the measure`);
    if (!m.expression.trim()) {
      add('error', 'Expression is empty');
      continue;
    }

    const body = stripLiterals(m.expression);
    let depth = 0;
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) add('error', 'Unbalanced parentheses');
    if ((m.expression.replace(/""/g, '').match(/"/g)?.length ?? 0) % 2) add('error', 'Unclosed string literal');
    if (/^\s*=/.test(m.expression)) add('warning', 'Remove the leading "=" — the generator adds it');

    for (const ref of findRefs(m.expression)) {
      if (ref.table === undefined) {
        if (!measureNames.has(ref.name.toLowerCase())) {
          add(
            allColumns.has(ref.name.toLowerCase()) ? 'warning' : 'error',
            allColumns.has(ref.name.toLowerCase())
              ? `[${ref.name}] is a column without a table name — write 'Table'[${ref.name}]`
              : `[${ref.name}] is not a measure or column`,
          );
        }
        continue;
      }
      const tableName = tableNames.get(ref.table.toLowerCase());
      if (!tableName) {
        if (ref.table.toLowerCase() === measureTable.toLowerCase() && measureNames.has(ref.name.toLowerCase())) continue;
        add('error', `Table "${ref.table}" does not exist`);
        continue;
      }
      const cols = tables.get(tableName)!;
      if (!cols.some((c) => c.name.toLowerCase() === ref.name.toLowerCase())) {
        add('error', `Column "${ref.name}" not found in table "${tableName}"`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// A tiny evaluator for simple measures, used for validation totals and the
// dashboard preview. Anything it does not understand evaluates to null and is
// computed only in Power BI.
// ---------------------------------------------------------------------------

export interface EvalTable {
  headers: string[];
  rows: Cell[][];
}

export interface EvalContext {
  measures: MeasureSpec[];
  model: ModelSpec;
  /** Rows of a model table, already restricted by the current filter. */
  rowsOf(table: string): EvalTable | null;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'ref'; table?: string; name: string }
  | { t: 'tbl'; name: string }
  | { t: 'fn'; name: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string };

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/\/\/[^\n]*|--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const m = s.slice(i).match(/^"((?:[^"]|"")*)"/);
      if (!m) return null;
      tokens.push({ t: 'str', v: m[1].replace(/""/g, '"') });
      i += m[0].length;
      continue;
    }
    const cmp = s.slice(i).match(/^(<=|>=|<>|<|>|=)/);
    if (cmp) {
      tokens.push({ t: 'op', v: cmp[1] });
      i += cmp[1].length;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = s.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (!m) return null;
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    const m = s.slice(i).match(/^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))?(\[((?:[^\]]|\]\])+)\])?/);
    if (!m || !m[0]) return null;
    const table = (m[1] ?? m[2])?.replace(/''/g, "'");
    if (m[3]) tokens.push({ t: 'ref', table, name: m[4].replace(/\]\]/g, ']') });
    else if (m[1]) tokens.push({ t: 'tbl', name: table! });
    else if (s[i + m[0].length] === '(' || /^\s*\(/.test(s.slice(i + m[0].length))) tokens.push({ t: 'fn', name: m[2]!.toUpperCase() });
    else tokens.push({ t: 'tbl', name: table! });
    i += m[0].length;
  }
  return tokens;
}

class Unsupported extends Error {}

export function evaluateMeasure(name: string, ctx: EvalContext, depth = 0): number | null {
  const m = ctx.measures.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!m || depth > 10) return null;
  const tokens = tokenize(m.expression.replace(/^\s*=/, ''));
  if (!tokens) return null;
  return evalTokens(tokens, ctx, depth);
}

type Filter = { table: string; column: string; op: string; value: number | string };

function matches(v: Cell, f: Filter): boolean {
  if (v === null) return false;
  const a = typeof f.value === 'number' ? (typeof v === 'number' ? v : Number(v)) : String(v).toLowerCase();
  const b = typeof f.value === 'number' ? f.value : f.value.toLowerCase();
  if (typeof a === 'number' && Number.isNaN(a)) return false;
  switch (f.op) {
    case '=':
      return a === b;
    case '<>':
      return a !== b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
  }
  return false;
}

/** Same context with extra column filters (CALCULATE). Only filters on the evaluated table itself are supported. */
function withFilters(ctx: EvalContext, filters: Filter[]): EvalContext {
  return {
    ...ctx,
    rowsOf(table) {
      const data = ctx.rowsOf(table);
      if (!data) return null;
      const own = filters.filter((f) => f.table.toLowerCase() === table.toLowerCase());
      if (own.length !== filters.length) throw new Unsupported();
      const ids = own.map((f) => data.headers.findIndex((h) => h.toLowerCase() === f.column.toLowerCase()));
      if (ids.some((i) => i < 0)) throw new Unsupported();
      return { headers: data.headers, rows: data.rows.filter((r) => own.every((f, k) => matches(r[ids[k]], f))) };
    },
  };
}

function evalTokens(tokens: Token[], ctx: EvalContext, depth: number): number | null {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Unsupported();
    pos++;
  };

  const column = (ref: { table?: string; name: string }) => {
    if (!ref.table) throw new Unsupported();
    const data = ctx.rowsOf(ref.table);
    if (!data) throw new Unsupported();
    const i = data.headers.findIndex((h) => h.toLowerCase() === ref.name.toLowerCase());
    if (i < 0) throw new Unsupported();
    return data.rows.map((r) => r[i]);
  };
  const nums = (vals: Cell[]) => vals.filter((v): v is number => typeof v === 'number');

  const primary = (): number | null => {
    const tok = tokens[pos++];
    if (!tok) throw new Unsupported();
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'op' && tok.v === '(') {
      const v = additive();
      expect(')');
      return v;
    }
    if (tok.t === 'op' && tok.v === '-') {
      const v = primary();
      return v === null ? null : -v;
    }
    if (tok.t === 'ref') {
      if (tok.table) throw new Unsupported();
      return evaluateMeasure(tok.name, ctx, depth + 1);
    }
    if (tok.t === 'fn') {
      expect('(');
      const fn = tok.name;
      if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'DISTINCTCOUNT', 'COUNTBLANK'].includes(fn)) {
        const arg = tokens[pos++];
        if (arg?.t !== 'ref') throw new Unsupported();
        expect(')');
        const vals = column(arg);
        const n = nums(vals);
        switch (fn) {
          case 'SUM':
            return n.length ? n.reduce((a, b) => a + b, 0) : null;
          case 'AVERAGE':
            return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
          case 'MIN':
            return n.length ? Math.min(...n) : null;
          case 'MAX':
            return n.length ? Math.max(...n) : null;
          case 'COUNT':
          case 'COUNTA': {
            const c = vals.filter((v) => v !== null && v !== '').length;
            return c || null;
          }
          case 'COUNTBLANK':
            return vals.filter((v) => v === null || v === '').length;
          case 'DISTINCTCOUNT': {
            const c = new Set(vals.filter((v) => v !== null).map((v) => String(v).toLowerCase())).size;
            return c || null;
          }
        }
      }
      if (fn === 'COUNTROWS') {
        const arg = tokens[pos++];
        if (arg?.t !== 'tbl') throw new Unsupported();
        expect(')');
        const data = ctx.rowsOf(arg.name);
        if (!data) throw new Unsupported();
        return data.rows.length || null;
      }
      if (fn === 'DIVIDE') {
        const a = additive();
        expect(',');
        const b = additive();
        let alt: number | null = null;
        if (isOp(',')) {
          pos++;
          alt = additive();
        }
        expect(')');
        if (a === null || b === null || b === 0) return alt;
        return a / b;
      }
      if (fn === 'CALCULATE') {
        // Split arguments at top-level commas.
        const args: Token[][] = [[]];
        let level = 0;
        for (;;) {
          const tok = tokens[pos++];
          if (!tok) throw new Unsupported();
          if (tok.t === 'op' && tok.v === '(') level++;
          if (tok.t === 'op' && tok.v === ')') {
            if (level === 0) break;
            level--;
          }
          if (tok.t === 'op' && tok.v === ',' && level === 0) args.push([]);
          else args[args.length - 1].push(tok);
        }
        const filters: Filter[] = args.slice(1).map((a) => {
          const [ref, op, val] = a;
          if (a.length !== 3 || ref.t !== 'ref' || !ref.table || op.t !== 'op' || !['=', '<>', '>', '<', '>=', '<='].includes(op.v)) throw new Unsupported();
          if (val.t !== 'num' && val.t !== 'str') throw new Unsupported();
          return { table: ref.table, column: ref.name, op: op.v, value: val.v };
        });
        return evalTokens(args[0], withFilters(ctx, filters), depth + 1);
      }
      throw new Unsupported();
    }
    throw new Unsupported();
  };

  const multiplicative = (): number | null => {
    let v = primary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { v: string }).v;
      const r = primary();
      if (v === null || r === null) v = null;
      else v = op === '*' ? v * r : r === 0 ? null : v / r;
    }
    return v;
  };

  const additive = (): number | null => {
    let v = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: string }).v;
      const r = multiplicative();
      // DAX treats BLANK as 0 in addition/subtraction.
      if (v === null && r === null) v = null;
      else v = op === '+' ? (v ?? 0) + (r ?? 0) : (v ?? 0) - (r ?? 0);
    }
    return v;
  };

  try {
    const v = additive();
    if (pos !== tokens.length) return null;
    return v === null || !Number.isFinite(v) ? null : v;
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}
