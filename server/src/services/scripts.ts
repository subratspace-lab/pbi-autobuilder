import type { AddColumnSpec, CleaningOp, ColumnType, FilterOperator, Project, ScriptTranslation, TransformScript } from '../../../shared/types.js';
import { newId } from './rules.js';

// Translates SQL (SELECT / CTE / view) and Python (pandas) transformation
// scripts into the app's cleaning steps, so the same logic ends up as named
// Power Query steps. It recognises the common cleaning patterns; anything else
// is reported as a note instead of being guessed. Scripts are never executed.

export function scriptLanguage(fileName: string): TransformScript['language'] | null {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'sql') return 'sql';
  if (ext === 'py' || ext === 'ipynb') return 'python';
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The table whose columns the script mentions most. */
export function detectScriptTable(script: TransformScript, project: Project): string | undefined {
  const text = norm(script.text);
  let best: { table: string; hits: number } | undefined;
  for (const t of project.tables) {
    const hits = t.headers.filter((h) => norm(h).length > 2 && text.includes(norm(h))).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { table: t.name, hits };
  }
  return best?.table;
}

/** Column names a script expects: an "Expected columns:" note if present, else the names it reads. */
export function scriptColumns(text: string): string[] {
  const note = text.match(/expected\s+columns\s*:?\s*\n?([\s\S]*?)(?:\n\s*\n|\*\/|"""|$)/i);
  if (note) {
    const cols = note[1].split(/[,\n]/).map((s) => s.replace(/^[\s#\-*]+|[\s"']+$/g, '').trim()).filter((s) => /^[\w ]{2,40}$/.test(s));
    if (cols.length >= 2) return [...new Set(cols)];
  }
  const fromPy = [...text.matchAll(/\[\s*["']([^"']{2,40})["']\s*\]/g)].map((m) => m[1]);
  return [...new Set(fromPy)];
}

/** Notebook (.ipynb) → plain code. */
export function scriptText(fileName: string, raw: string): string {
  if (!fileName.toLowerCase().endsWith('.ipynb')) return raw;
  try {
    const nb = JSON.parse(raw) as { cells?: { cell_type: string; source: string | string[] }[] };
    return (nb.cells ?? [])
      .filter((c) => c.cell_type === 'code')
      .map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source))
      .join('\n\n');
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Arithmetic expressions shared by both languages
// ---------------------------------------------------------------------------

type Ast = { t: 'col'; name: string } | { t: 'num'; v: number } | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Ast; r: Ast } | { t: 'round'; x: Ast; d: number };

type Tok = { k: 'id' | 'num' | 'str' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:\[([^\]]+)\]|"([^"]*)"|'((?:[^']|'')*)'|(\d+(?:\.\d+)?)|([A-Za-z_][\w.]*)|(<=|>=|<>|!=|==|[-+*/(),<>=]))/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ k: 'id', v: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ k: 'str', v: (m[2] ?? m[3]!).replace(/''/g, "'") });
    else if (m[4] !== undefined) out.push({ k: 'num', v: m[4] });
    else if (m[5] !== undefined) out.push({ k: 'id', v: m[5] });
    else if (m[6] !== undefined) out.push({ k: 'op', v: m[6] });
    if (!m[0]) break;
  }
  return out;
}

const PASS_THROUGH_FIRST = new Set(['coalesce', 'isnull', 'ifnull', 'nullif', 'cast', 'try_cast', 'nz']);
const PASS_THROUGH_LAST = new Set(['convert', 'try_convert']);

/** Parse an arithmetic expression; null when it uses something we do not translate. */
function parseArithmetic(src: string, resolve: (name: string) => string | undefined): Ast | null {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v;
  class Bail extends Error {}

  const args = (): Tok[][] => {
    // collect raw argument token lists of a call; i points after "("
    const list: Tok[][] = [[]];
    let depth = 0;
    for (;;) {
      const t = toks[i++];
      if (!t) throw new Bail();
      if (t.k === 'op' && t.v === '(') depth++;
      if (t.k === 'op' && t.v === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (t.k === 'op' && t.v === ',' && depth === 0) list.push([]);
      else list[list.length - 1].push(t);
    }
    return list;
  };
  const sub = (ts: Tok[]): Ast => {
    // strip a trailing "AS <type>" (SQL CAST)
    const asAt = ts.findIndex((t) => t.k === 'id' && t.v.toUpperCase() === 'AS');
    const body = asAt >= 0 ? ts.slice(0, asAt) : ts;
    const ast = parseArithmetic(body.map((t) => (t.k === 'id' ? `[${t.v}]` : t.k === 'str' ? `'${t.v}'` : t.v)).join(' '), resolve);
    if (!ast) throw new Bail();
    return ast;
  };

  const primary = (): Ast => {
    const t = toks[i++];
    if (!t) throw new Bail();
    if (t.k === 'num') return { t: 'num', v: Number(t.v) };
    if (t.k === 'op' && t.v === '(') {
      const x = additive();
      if (!isOp(')')) throw new Bail();
      i++;
      return x;
    }
    if (t.k === 'op' && t.v === '-') {
      const x = primary();
      return x.t === 'num' ? { t: 'num', v: -x.v } : { t: 'bin', op: '*', l: { t: 'num', v: -1 }, r: x };
    }
    if (t.k === 'id') {
      if (isOp('(')) {
        i++;
        const fn = t.v.toLowerCase();
        const a = args();
        if (PASS_THROUGH_FIRST.has(fn)) return sub(a[0]);
        if (PASS_THROUGH_LAST.has(fn)) return sub(a[a.length - 1]);
        if (fn === 'round' && a.length === 2 && a[1].length === 1 && a[1][0].k === 'num') return { t: 'round', x: sub(a[0]), d: Number(a[1][0].v) };
        throw new Bail();
      }
      const col = resolve(t.v);
      if (!col) throw new Bail();
      return { t: 'col', name: col };
    }
    throw new Bail();
  };
  const multiplicative = (): Ast => {
    let x = primary();
    while (isOp('*') || isOp('/')) {
      const op = toks[i++].v as '*' | '/';
      x = { t: 'bin', op, l: x, r: primary() };
    }
    return x;
  };
  const additive = (): Ast => {
    let x = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = toks[i++].v as '+' | '-';
      x = { t: 'bin', op, l: x, r: multiplicative() };
    }
    return x;
  };
  try {
    const ast = additive();
    return i === toks.length ? ast : null;
  } catch (e) {
    if (e instanceof Bail) return null;
    throw e;
  }
}

/** Canonical key; * and + are commutative. */
function key(a: Ast): string {
  switch (a.t) {
    case 'col':
      return `c:${a.name}`;
    case 'num':
      return `n:${a.v}`;
    case 'round':
      return key(a.x);
    case 'bin': {
      const [l, r] = [key(a.l), key(a.r)];
      return a.op === '*' || a.op === '+' ? `(${[l, r].sort().join(a.op)})` : `(${l}${a.op}${r})`;
    }
  }
}

/** Replace sub-expressions already computed as columns (bottom-up). */
function substitute(a: Ast, known: Map<string, string>): Ast {
  let x = a;
  if (a.t === 'bin') x = { ...a, l: substitute(a.l, known), r: substitute(a.r, known) };
  if (a.t === 'round') x = { ...a, x: substitute(a.x, known) };
  const hit = known.get(key(x));
  return hit ? { t: 'col', name: hit } : x;
}

/** Map an expression onto the app's arithmetic column (two operands, optional scale and round). */
function toArithmetic(a: Ast): AddColumnSpec | null {
  let round: number | undefined;
  let x = a;
  if (x.t === 'round') {
    round = x.d;
    x = x.x;
  }
  let scale: number | undefined;
  if (x.t === 'bin' && x.r.t === 'num' && x.l.t === 'bin' && (x.op === '*' || x.op === '/')) {
    scale = x.op === '*' ? x.r.v : 1 / x.r.v;
    x = x.l;
  } else if (x.t === 'bin' && x.l.t === 'num' && x.r.t === 'bin' && x.op === '*') {
    scale = x.l.v;
    x = x.r;
  }
  if (x.t !== 'bin') return null;
  let { l, r } = x;
  const op = x.op;
  if (l.t === 'num' && r.t === 'col' && (op === '*' || op === '+')) [l, r] = [r, l];
  if (l.t !== 'col' || (r.t !== 'col' && r.t !== 'num')) return null;
  return {
    kind: 'arithmetic',
    left: l.name,
    operator: op,
    right: r.t === 'col' ? r.name : r.v,
    ...(scale !== undefined ? { scale: Number(scale.toPrecision(12)) } : {}),
    ...(round !== undefined ? { round } : {}),
  };
}

// ---------------------------------------------------------------------------
// Collector: builds ops in a sensible order and de-duplicates them
// ---------------------------------------------------------------------------

class Collector {
  private trims = new Set<string>();
  private empties = new Set<string>();
  private cases: { col: string; op: 'upperCase' | 'lowerCase' | 'properCase' }[] = [];
  private types = new Map<string, ColumnType>();
  private filters: CleaningOp[] = [];
  private dedupe?: CleaningOp;
  private fills: CleaningOp[] = [];
  private derived: CleaningOp[] = [];
  private renames: CleaningOp[] = [];
  private known = new Map<string, string>(); // expression key → column
  readonly notes: string[] = [];
  readonly created = new Set<string>();

  constructor(
    private headers: string[],
    private source: string,
  ) {}

  /** Existing column (case/space-insensitive) or a column created earlier by the script. */
  resolve = (name: string): string | undefined => {
    const n = norm(name);
    return this.headers.find((h) => norm(h) === n) ?? [...this.created].find((c) => norm(c) === n);
  };

  private base(reason: string) {
    return { id: newId(), enabled: true, reason: `${this.source}: ${reason}` };
  }

  trim(col: string) {
    this.trims.add(col);
  }
  emptyToNull(col: string) {
    this.empties.add(col);
  }
  textCase(col: string, op: 'upperCase' | 'lowerCase' | 'properCase') {
    if (!this.cases.some((c) => c.col === col && c.op === op)) this.cases.push({ col, op });
  }
  type(col: string, type: ColumnType) {
    this.types.set(col, type);
  }
  notBlank(col: string) {
    if (!this.filters.some((f) => f.op === 'removeRowsWithBlank' && f.column === col)) {
      this.filters.push({ ...this.base(`drop rows where ${col} is missing`), op: 'removeRowsWithBlank', column: col });
    }
  }
  filter(col: string, operator: FilterOperator, value: string | number, text: string) {
    this.filters.push({ ...this.base(`keep rows where ${text}`), op: 'filterRows', column: col, operator, value });
  }
  removeDuplicates(cols: string[], how: string) {
    this.dedupe = { ...this.base(how), op: 'removeDuplicates', columns: cols.length ? cols : undefined };
  }
  fill(col: string, value: string | number) {
    if (!this.fills.some((f) => f.op === 'replaceNulls' && f.column === col)) {
      this.fills.push({ ...this.base(`missing ${col} → ${JSON.stringify(value)}`), op: 'replaceNulls', column: col, value });
    }
  }
  rename(from: string, to: string) {
    this.renames.push({ ...this.base(`${from} renamed to ${to}`), op: 'rename', from, to });
  }

  derive(name: string, spec: AddColumnSpec, what: string) {
    if (this.resolve(name) && !this.created.has(name)) {
      this.notes.push(`"${name}" already exists in the data — the script's version was not added`);
      return;
    }
    this.derived.push({ ...this.base(what), op: 'addColumn', name, spec });
    this.created.add(name);
  }

  /** Try to add an arithmetic column from an expression. */
  arithmetic(name: string, expr: string, round?: number) {
    const ast = parseArithmetic(expr, this.resolve);
    if (!ast) return false;
    const full: Ast = round !== undefined ? { t: 'round', x: ast, d: round } : ast;
    const simplified = substitute(full, this.known);
    const spec = toArithmetic(simplified);
    if (!spec) return false;
    this.derive(name, spec, `${name} = ${expr.replace(/\s+/g, ' ').trim()}`);
    this.known.set(key(full.t === 'round' ? full.x : full), name);
    if (simplified.t !== 'col') this.known.set(key(simplified.t === 'round' ? simplified.x : simplified), name);
    return true;
  }

  ops(): CleaningOp[] {
    const out: CleaningOp[] = [];
    if (this.trims.size) out.push({ ...this.base('trim spaces'), op: 'trim', columns: [...this.trims] });
    if (this.empties.size) out.push({ ...this.base('blank text → null'), op: 'emptyToNull', columns: [...this.empties] });
    for (const c of this.cases) out.push({ ...this.base(`${c.op === 'upperCase' ? 'UPPER' : c.op === 'lowerCase' ? 'lower' : 'Title'} case`), op: c.op, columns: [c.col] });
    for (const [column, type] of this.types) out.push({ ...this.base(`convert to ${type}`), op: 'setType', column, type });
    out.push(...this.filters);
    if (this.dedupe) out.push(this.dedupe);
    out.push(...this.fills, ...this.derived, ...this.renames);
    return out;
  }
}

function literal(t: string): string | number | null {
  const s = t.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:N?'((?:[^']|'')*)'|"([^"]*)")$/);
  if (m) return (m[1] ?? m[2]).replace(/''/g, "'");
  return null;
}

const OPS: Record<string, FilterOperator> = { '>': 'greaterThan', '>=': 'greaterOrEqual', '<': 'lessThan', '<=': 'lessOrEqual', '=': 'equals', '==': 'equals', '<>': 'notEquals', '!=': 'notEquals' };

/** Split at top-level separators (commas or a keyword like AND), ignoring brackets and strings. */
function splitTop(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0) {
      const m = s.slice(i).match(sep);
      if (m && m.index === 0) {
        parts.push(s.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function sqlType(t: string): ColumnType | null {
  const s = t.toLowerCase();
  if (/^date$/.test(s)) return 'date';
  if (/datetime|smalldatetime|timestamp/.test(s)) return 'datetime';
  if (/^(int|bigint|smallint|tinyint|integer)$/.test(s)) return 'integer';
  if (/decimal|numeric|float|real|money|double/.test(s)) return 'number';
  if (/char|text|string/.test(s)) return 'text';
  if (/^bit|bool/.test(s)) return 'boolean';
  return null;
}

/** The single column referenced by an expression (ignoring function names / type keywords). */
function singleColumn(expr: string, c: Collector): string | undefined {
  const ids = tokenize(expr)
    .map((t, i, all) => ({ t, next: all[i + 1] }))
    .filter(({ t, next }) => t.k === 'id' && !(next?.k === 'op' && next.v === '('))
    .map(({ t }) => c.resolve(t.v))
    .filter((x): x is string => Boolean(x));
  const unique = [...new Set(ids)];
  return unique.length === 1 ? unique[0] : undefined;
}

function translateSql(text: string, c: Collector) {
  const sql = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = sql.split(/;\s*|\n\s*GO\s*\n/i).map((s) => s.trim()).filter(Boolean);
  // The transformation is the statement that builds the view/table; later SELECTs are validation queries.
  const main = statements.find((s) => /\b(CREATE|ALTER)\b[\s\S]*\b(VIEW|TABLE)\b|\bINTO\b/i.test(s)) ?? statements.find((s) => /\bSELECT\b/i.test(s)) ?? '';
  const extra = statements.filter((s) => s !== main && /\bSELECT\b/i.test(s));
  if (extra.length) c.notes.push(`${extra.length} extra SELECT quer${extra.length > 1 ? 'ies' : 'y'} (validation / summaries) — covered by the report measures instead`);

  // SELECT lists
  for (const m of main.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) {
    for (const item of splitTop(m[1], /,/)) {
      if (item === '*') continue;
      const am = item.match(/^([\s\S]*?)\s+AS\s+\[?([^\]\s,]+(?:\s[^\]\s,]+)*)\]?$/i);
      const expr = (am ? am[1] : item).trim();
      const alias = (am ? am[2] : item).trim();
      sqlItem(expr, alias, c);
    }
  }

  // WHERE conditions
  for (const m of main.matchAll(/\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\)\s*(?:,|SELECT|$)|$)/gi)) {
    for (const cond of splitTop(m[1].trim(), /\s+AND\s+/i)) {
      const nn = cond.match(/^\[?([\w ]+?)\]?\s+IS\s+NOT\s+NULL$/i);
      if (nn) {
        const col = c.resolve(nn[1]);
        if (col) c.notBlank(col);
        else if (!/^rn$/i.test(nn[1])) c.notes.push(`WHERE ${cond} — column not found`);
        continue;
      }
      const cmp = cond.match(/^\[?([\w ]+?)\]?\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
      if (cmp) {
        if (/^rn$/i.test(cmp[1])) continue; // ROW_NUMBER de-duplication, handled separately
        const col = c.resolve(cmp[1]);
        const value = literal(cmp[3]);
        if (col && value !== null) {
          c.filter(col, OPS[cmp[2]], value, cond);
          continue;
        }
      }
      c.notes.push(`WHERE condition not translated: ${cond.replace(/\s+/g, ' ')}`);
    }
  }
}

function sqlItem(expr: string, alias: string, c: Collector) {
  const lower = expr.toLowerCase();
  // De-duplication via ROW_NUMBER() OVER (PARTITION BY …)
  const rn = expr.match(/ROW_NUMBER\s*\(\s*\)\s*OVER\s*\(\s*PARTITION\s+BY\s+([\s\S]*?)(?:\s+ORDER\s+BY\s+([\s\S]*))?\)\s*$/i);
  if (rn) {
    const keys = splitTop(rn[1], /,/)
      .map((k) => singleColumn(k, c))
      .filter((k): k is string => Boolean(k));
    if (keys.length) {
      c.removeDuplicates(keys, `remove duplicate ${keys.join(', ')} (ROW_NUMBER … = 1)`);
      if (rn[2]) c.notes.push(`Duplicates: the script keeps the row with ${rn[2].replace(/\s+/g, ' ').trim()}; the app keeps the first row it finds — sort first if the order matters`);
    }
    return;
  }

  // Derived date parts
  const datePart = (re: RegExp) => expr.match(re)?.[1];
  const target = (part: AddColumnSpec & { kind: 'datePart' }) => c.derive(alias, part, `${alias} from ${part.column}`);
  const col1 = singleColumn(expr, c);
  if (/^concat\s*\(\s*year\s*\(/i.test(expr) && /month\s*\(/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'yearMonth' });
  if (/^format\s*\(.*['"]yyyy-MM['"]\s*\)$/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'yearMonth' });
  if (/^year\s*\(/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'year' });
  if (/^month\s*\(/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'month' });
  if (/^day\s*\(/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'day' });
  if (/^datename\s*\(\s*(month|mm|m)\s*,/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'monthName' });
  if (/^datename\s*\(\s*(weekday|dw)\s*,/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'weekdayName' });
  if (/^datepart\s*\(\s*(quarter|qq|q)\s*,/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'quarter' });
  if (/^datediff\s*\(\s*year\s*,/i.test(expr) && col1) return target({ kind: 'datePart', column: col1, part: 'age' });
  void datePart;

  // Plain column (possibly renamed)
  const plain = c.resolve(expr.replace(/^\[|\]$/g, ''));
  if (plain) {
    if (norm(alias) !== norm(plain) && !c.resolve(alias)) c.rename(plain, alias);
    return;
  }

  // Cleaning of a single column: TRIM / NULLIF / UPPER / CONVERT / COALESCE …
  const looksLikeCleaning = /^(nullif|ltrim|rtrim|trim|upper|lower|try_convert|convert|cast|try_cast|coalesce|isnull)\s*\(/i.test(expr);
  if (looksLikeCleaning && col1 && !/[+\-*/]\s*\[?\w/.test(expr.replace(/\([^()]*\)/g, ''))) {
    if (/\b(ltrim|rtrim|trim)\s*\(/i.test(expr)) c.trim(col1);
    if (/^nullif\s*\(/i.test(expr) && /,\s*(N?''|"")\s*\)\s*$/i.test(expr.replace(/\)\s*AS\s+\w+$/i, ''))) c.emptyToNull(col1);
    if (/nullif\s*\([\s\S]*,\s*N?''\s*\)/i.test(expr)) c.emptyToNull(col1);
    if (/\bupper\s*\(/i.test(lower)) c.textCase(col1, 'upperCase');
    if (/\blower\s*\(/i.test(lower)) c.textCase(col1, 'lowerCase');
    const conv = expr.match(/\b(?:try_)?convert\s*\(\s*(\w+)/i) ?? expr.match(/\b(?:try_)?cast\s*\([\s\S]*?\bAS\s+(\w+)/i);
    if (conv) {
      const t = sqlType(conv[1]);
      if (t && t !== 'text') c.type(col1, t);
    }
    const co = expr.match(/^(?:coalesce|isnull)\s*\(([\s\S]*),\s*([^,()]+)\s*\)$/i);
    if (co) {
      const v = literal(co[2]);
      if (v !== null) c.fill(col1, v);
    }
    if (norm(alias) !== norm(col1) && !c.resolve(alias)) c.rename(col1, alias);
    return;
  }

  // Calculated column (CAST … AS decimal(p, s) also rounds to s decimals)
  const decimals = expr.match(/^(?:try_)?cast\s*\([\s\S]*\bAS\s+(?:decimal|numeric)\s*\(\s*\d+\s*,\s*(\d+)\s*\)\s*\)$/i)?.[1];
  if (c.arithmetic(alias, expr, decimals !== undefined ? Number(decimals) : undefined)) return;
  c.notes.push(`Column "${alias}" not translated: ${expr.replace(/\s+/g, ' ').slice(0, 140)}`);
}

// ---------------------------------------------------------------------------
// Python (pandas)
// ---------------------------------------------------------------------------

/** Join physical lines into logical statements (open brackets continue a line). */
function pythonStatements(code: string): { text: string; indent: number }[] {
  const out: { text: string; indent: number }[] = [];
  let buf = '';
  let depth = 0;
  let indent = 0;
  for (const raw of code.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (!buf) {
      if (!line.trim()) continue;
      indent = line.length - line.trimStart().length;
    }
    buf += (buf ? ' ' : '') + line.trim();
    for (const ch of line.replace(/"[^"]*"|'[^']*'/g, '')) {
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
    }
    if (depth <= 0 && !buf.endsWith('\\')) {
      out.push({ text: buf, indent });
      buf = '';
      depth = 0;
    }
  }
  return out.filter((s) => !/^("""|''')/.test(s.text));
}

function pyStrings(s: string): string[] {
  return [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

function translatePython(code: string, c: Collector) {
  // Remove docstrings first.
  const statements = pythonStatements(code.replace(/("""|''')[\s\S]*?\1/g, ''));
  const lists = new Map<string, string[]>();
  const df = '(?:df|data|sales|frame|d)';
  const colRef = new RegExp(`${df}\\[\\s*["']([^"']+)["']\\s*\\]`, 'g');
  /** Replace df["X"] with [X] so expressions can be parsed. */
  const exprOf = (s: string) => s.replace(colRef, (_m, n: string) => `[${n}]`);

  const applyToColumns = (cols: string[], body: string) => {
    for (const name of cols) {
      const col = c.resolve(name);
      if (!col) {
        c.notes.push(`Column "${name}" mentioned in the script was not found in the data`);
        continue;
      }
      columnChain(col, body);
    }
  };

  /** Methods chained on one column: .str.strip(), .replace("", NA), .fillna(x), .str.upper(), to_datetime … */
  const columnChain = (col: string, s: string) => {
    if (/\.str\.strip\(\)|\.strip\(\)/.test(s)) c.trim(col);
    if (/\.replace\(\s*(""|'')\s*,\s*(pd\.NA|np\.nan|None|pd\.NaT)\s*\)/.test(s)) c.emptyToNull(col);
    if (/\.str\.upper\(\)/.test(s)) c.textCase(col, 'upperCase');
    if (/\.str\.lower\(\)/.test(s)) c.textCase(col, 'lowerCase');
    if (/\.str\.title\(\)/.test(s)) c.textCase(col, 'properCase');
    if (/pd\.to_datetime\(/.test(s)) c.type(col, 'date');
    if (/pd\.to_numeric\(/.test(s)) c.type(col, 'number');
    const astype = s.match(/\.astype\(\s*["']?(int|int64|Int64|float|float64|str|string|bool|datetime64\[ns\])["']?\s*\)/);
    if (astype) {
      const t = /int/i.test(astype[1]) ? 'integer' : /float/.test(astype[1]) ? 'number' : /bool/.test(astype[1]) ? 'boolean' : /datetime/.test(astype[1]) ? 'date' : null;
      if (t) c.type(col, t);
    }
    const fill = s.match(/\.fillna\(\s*([^)]+?)\s*\)/);
    if (fill) {
      const v = literal(fill[1]);
      if (v !== null) c.fill(col, v);
    }
    if (/\.clip\(/.test(s)) c.notes.push(`${col}: .clip(…) (cap values) not translated — check the range in Power Query if needed`);
  };

  for (let k = 0; k < statements.length; k++) {
    const { text: s, indent } = statements[k];

    // name = ["A", "B"]
    const lm = s.match(/^(\w+)\s*=\s*\[([^\]]*)\]$/);
    if (lm && !s.startsWith('df')) {
      lists.set(lm[1], pyStrings(lm[2]));
      continue;
    }

    // for col in LIST:  /  for col, fallback in {...}.items():
    const loop = s.match(/^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+?):$/);
    if (loop) {
      const body: string[] = [];
      while (k + 1 < statements.length && statements[k + 1].indent > indent) body.push(statements[++k].text);
      const iter = loop[3].trim();
      const dict = iter.match(/^\{([\s\S]*)\}\.items\(\)$/);
      if (dict && loop[2]) {
        for (const pair of splitTop(dict[1], /,/)) {
          const pm = pair.match(/^["']([^"']+)["']\s*:\s*(.+)$/);
          const col = pm && c.resolve(pm[1]);
          const v = pm ? literal(pm[2]) : null;
          if (col && v !== null && body.some((b) => b.includes(`.fillna(${loop[2]})`))) c.fill(col, v);
          else if (pm && !col) c.notes.push(`Column "${pm[1]}" mentioned in the script was not found in the data`);
        }
        continue;
      }
      const cols = lists.get(iter) ?? (iter.startsWith('[') ? pyStrings(iter) : []);
      if (!cols.length) {
        c.notes.push(`Loop not translated: ${s}`);
        continue;
      }
      for (const b of body) applyToColumns(cols, b.replace(new RegExp(`\\[\\s*${loop[1]}\\s*\\]`, 'g'), ''));
      continue;
    }

    // df = df.dropna(subset=[...])
    const dn = s.match(/\.dropna\(\s*subset\s*=\s*\[([^\]]*)\]/);
    if (dn) {
      for (const name of pyStrings(dn[1])) {
        const col = c.resolve(name);
        if (col) c.notBlank(col);
      }
    } else if (/\.dropna\(\s*\)/.test(s)) c.notes.push('dropna() on every column not translated — choose the key columns that must not be blank');

    // df = df.drop_duplicates(subset=[...], keep=...)
    const dd = s.match(/\.drop_duplicates\(([^)]*)\)/);
    if (dd) {
      const sub = dd[1].match(/subset\s*=\s*\[([^\]]*)\]|subset\s*=\s*["']([^"']+)["']/);
      const keys = sub ? (sub[1] ? pyStrings(sub[1]) : [sub[2]]).map((n) => c.resolve(n)).filter((x): x is string => Boolean(x)) : [];
      c.removeDuplicates(keys, keys.length ? `remove duplicate ${keys.join(', ')} (drop_duplicates)` : 'remove duplicate rows (drop_duplicates)');
      if (/keep\s*=\s*["']last["']/.test(dd[1]) || /sort_values/.test(s)) {
        c.notes.push('Duplicates: the script sorts and keeps the last row; the app keeps the first row it finds — sort first if the order matters');
      }
    }

    // df = df[(df["A"] > 0) & (df["B"] >= 0)]
    if (/^\w+\s*=\s*\w+\[\s*\(?\s*\w+\[/.test(s) && !/=\s*\w+\[\s*["']/.test(s)) {
      for (const m of s.matchAll(new RegExp(`${df}\\[\\s*["']([^"']+)["']\\s*\\]\\s*(>=|<=|==|!=|>|<)\\s*([-\\d.]+|"[^"]*"|'[^']*')`, 'g'))) {
        const col = c.resolve(m[1]);
        const v = literal(m[3]);
        if (col && v !== null) c.filter(col, OPS[m[2]], v, `${m[1]} ${m[2]} ${m[3]}`);
      }
      continue;
    }

    // df["X"] = <expression>
    const asg = s.match(new RegExp(`^${df}\\[\\s*["']([^"']+)["']\\s*\\]\\s*=\\s*([\\s\\S]+)$`));
    if (asg) {
      const target = asg[1];
      const rhs = asg[2].trim();
      const same = c.resolve(target);
      const refs = [...rhs.matchAll(colRef)].map((m) => m[1]);
      const onlySelf = same && refs.length > 0 && refs.every((r) => norm(r) === norm(target));
      // Date parts
      const dt = rhs.match(new RegExp(`^${df}\\[\\s*["']([^"']+)["']\\s*\\]\\.dt\\.(year|month|day|quarter|month_name\\(\\)|day_name\\(\\)|strftime\\(\\s*["']([^"']+)["']\\s*\\))$`));
      if (dt) {
        const src = c.resolve(dt[1]);
        const part = dt[2].startsWith('strftime') ? (dt[3] === '%Y-%m' ? 'yearMonth' : null) : ({ year: 'year', month: 'month', day: 'day', quarter: 'quarter', 'month_name()': 'monthName', 'day_name()': 'weekdayName' } as const)[dt[2] as 'year'];
        if (src && part && norm(target) !== norm(dt[1])) {
          c.derive(target, { kind: 'datePart', column: src, part }, `${target} from ${src}`);
          continue;
        }
        if (src && norm(target) === norm(dt[1])) {
          c.notes.push(`${target}: re-formatting the date as text (${dt[2]}) not needed — Power BI formats dates itself`);
          continue;
        }
      }
      // Cleaning chain on the same column
      if (onlySelf && /\.(str\.|replace\(|fillna\(|astype\(|clip\()|pd\.to_(datetime|numeric)\(/.test(rhs)) {
        columnChain(same!, rhs);
        continue;
      }
      // Arithmetic: (df["A"] * df["B"]).round(2)
      const roundM = rhs.match(/^\(([\s\S]*)\)\.round\(\s*(\d+)\s*\)$/);
      const expr = exprOf(roundM ? roundM[1] : rhs);
      if (c.arithmetic(target, expr, roundM ? Number(roundM[2]) : undefined)) continue;
      c.notes.push(`Column "${target}" not translated: ${rhs.slice(0, 140)}`);
      continue;
    }

    if (/\.columns\s*=\s*.*\.str\.strip\(\)/.test(s)) continue; // header spaces are trimmed on import
    if (/\.groupby\(/.test(s)) {
      c.notes.push('Summary tables (groupby) — covered by the report measures and visuals instead');
      continue;
    }
  }
}

// ---------------------------------------------------------------------------

export function translateScript(script: TransformScript, headers: string[]): Omit<ScriptTranslation, 'table'> {
  const c = new Collector(headers, script.fileName);
  try {
    if (script.language === 'sql') translateSql(script.text, c);
    else translatePython(script.text, c);
  } catch (e) {
    c.notes.push(`The script could not be read completely: ${(e as Error).message}`);
  }
  const ops = c.ops();
  if (!ops.length) c.notes.push('No cleaning steps were recognised in this script.');
  return { ops, notes: [...new Set(c.notes)] };
}
