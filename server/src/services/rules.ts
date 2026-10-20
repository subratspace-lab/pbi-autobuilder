import crypto from 'node:crypto';
import type {
  Analysis,
  CleanedColumn,
  CleaningOp,
  FieldRef,
  MeasureSpec,
  ModelSpec,
  ModelTable,
  Project,
  Relationship,
  ReportSpec,
  TableProfile,
  VisualSpec,
} from '../../../shared/types.js';
import { buildModelData, MEASURE_TABLE, modelColumns } from './model.js';
import { daxColumn, daxMeasureRef, daxTable } from './dax.js';
import { DEFAULT_THEME } from './report.js';
import { isIdLikeName } from './values.js';

// Deterministic, explainable suggestions. Used when no AI key is configured
// and as a safety net when the AI's answer is incomplete.

export const newId = () => crypto.randomBytes(10).toString('hex');

const NUMERIC = new Set(['number', 'integer', 'currency']);
const MONEY_RE = /sales|revenue|amount|income|value|price|cost|profit|spend|total|fare|fee|salary|budget|outstanding|balance|debt|liabilit|exposure|principal|emi|interest/i;
const PRIMARY_RE = /sales|revenue|amount|income|turnover/i;
const RATE_RE = /discount|rate|percent|pct|ratio|margin|score|rating|age$|^age|\bdpd\b|days|tenure/i;
const FLAG_RE = /flag$|^is\s|^has\s|\bdefault(ed|er)?\b|churn|fraud/i;
const TOP_CATEGORY_RE = /region|category|segment|department|channel|country|bucket|band|type/i;
const CATEGORY_RE = /category|product|region|segment|city|state|country|channel|type|department|brand|status|gender|class|market|store|team|mode|source|band|bucket|grade|tier/i;

// ---------- analysis ----------

export function analysisRules(project: Project): Analysis {
  const kpis: Analysis['kpis'] = [];
  for (const p of project.profiles) {
    kpis.push({ name: `Total ${p.table} Records`, definition: `Number of rows in ${p.table}`, formulaHint: `COUNTROWS(${p.table})` });
    for (const c of p.columns.filter((c) => NUMERIC.has(c.inferredType) && !isIdLikeName(c.name)).slice(0, 4)) {
      kpis.push({ name: `Total ${c.name}`, definition: `Sum of ${c.name}`, formulaHint: `SUM(${p.table}[${c.name}])` });
    }
  }
  const issues = project.profiles.flatMap((p) => [
    ...(p.duplicateRows ? [`${p.table}: ${p.duplicateRows} duplicate rows`] : []),
    ...(p.blankRows ? [`${p.table}: ${p.blankRows} blank rows`] : []),
    ...p.columns.flatMap((c) => c.issues.map((i) => `${p.table}[${c.name}]: ${i}`)),
  ]);
  return {
    businessSummary:
      `The dataset has ${project.profiles.length} table(s): ` +
      project.profiles.map((p) => `${p.table} (${p.rowCount} rows, ${p.columns.length} columns)`).join(', ') +
      '. Configure an AI provider in Settings for a business-level summary based on the project brief.',
    businessQuestions: ['How are the key totals trending over time?', 'Which categories contribute most?', 'Where are the outliers or under-performers?'],
    kpis: kpis.slice(0, 10),
    dataIssues: issues.slice(0, 40),
    dashboardIdea: 'KPI cards on top, monthly trend, breakdown by main categories, detail matrix and slicers for date and categories.',
    source: 'rules',
  };
}

// ---------- cleaning ----------

function op<T extends Omit<CleaningOp, 'id' | 'enabled'>>(o: T, reason: string): CleaningOp {
  return { id: newId(), enabled: true, reason, ...o } as unknown as CleaningOp;
}

export function cleaningRules(profile: TableProfile): CleaningOp[] {
  const ops: CleaningOp[] = [];
  if (profile.blankRows > 0) ops.push(op({ op: 'removeBlankRows' }, `${profile.blankRows} completely blank rows`));

  const textCols = profile.columns.filter((c) => c.inferredType === 'text');
  const trimCols = profile.columns.filter((c) => c.stats.whitespace > 0).map((c) => c.name);
  if (trimCols.length) ops.push(op({ op: 'trim', columns: trimCols }, 'Leading/trailing spaces found'));

  for (const c of textCols) {
    if (c.stats.caseVariants > 0 && !isIdLikeName(c.name)) {
      const tops = c.topValues.map((t) => t.value.trim()).filter((v) => /[a-z]/i.test(v));
      const upper = tops.filter((v) => v === v.toUpperCase()).length;
      const proper = tops.filter((v) => /^(\p{Lu}[\p{Ll}'’]*)([\s-]\p{Lu}[\p{Ll}'’]*)*$/u.test(v)).length;
      if (upper > tops.length / 2) ops.push(op({ op: 'upperCase', columns: [c.name] }, 'Same values written with different casing'));
      else if (proper >= tops.length / 2) ops.push(op({ op: 'properCase', columns: [c.name] }, 'Same values written with different casing'));
    }
  }

  // Currency symbols stop the column from becoming numeric.
  for (const c of profile.columns) {
    if (c.stats.currencyLike > 0 && c.stats.currencyLike + c.stats.numericLike >= (c.count - c.nulls) * 0.9) {
      for (const sym of c.stats.currencySymbols ?? ['$']) {
        ops.push(op({ op: 'replaceValues', column: c.name, find: sym, replace: '', wholeValue: false }, 'Remove currency symbol'));
      }
      ops.push(op({ op: 'setType', column: c.name, type: 'number' }, 'Currency amounts stored as text'));
    }
  }

  const blanks = textCols.filter((c) => c.nulls > 0).map((c) => c.name);
  if (blanks.length) ops.push(op({ op: 'emptyToNull', columns: blanks }, 'Empty strings become proper nulls'));

  for (const c of profile.columns) {
    const nonNull = c.count - c.nulls;
    if (c.inferredType === 'date' || c.inferredType === 'datetime') {
      ops.push(op({ op: 'setType', column: c.name, type: 'date' }, 'Store as a date so it can link to the Date table'));
    } else if (c.inferredType === 'text' && nonNull > 0 && c.stats.numericLike / nonNull >= 0.9 && !isIdLikeName(c.name) && c.stats.currencyLike === 0) {
      ops.push(op({ op: 'setType', column: c.name, type: 'number' }, 'Mostly numeric — non-numeric values become null'));
    } else if (c.inferredType === 'text' && nonNull > 0 && c.stats.dateLike / nonNull >= 0.8) {
      ops.push(op({ op: 'setType', column: c.name, type: 'date' }, 'Mostly dates — unparseable values become null'));
    }
  }

  if (profile.duplicateRows > 0) ops.push(op({ op: 'removeDuplicates' }, `${profile.duplicateRows} exact duplicate rows`));
  ops.push(...bandRules(profile));
  return ops;
}

const DPD_RE = /\bdpd\b|days past due|overdue days|days overdue/i;
const SCORE_RE = /\b(cibil|credit|bureau|fico)?\s*score\b/i;
const DOB_RE = /\bdob\b|date of birth|birth ?date/i;

/** Analysis-friendly bands for well-known measures (DPD, credit score, age). */
function bandRules(profile: TableProfile): CleaningOp[] {
  const ops: CleaningOp[] = [];
  const names = new Set(profile.columns.map((c) => c.name.toLowerCase()));
  const free = (n: string) => !names.has(n.toLowerCase()) && !names.has(`${n} sort`.toLowerCase());
  for (const c of profile.columns) {
    const numeric = NUMERIC.has(c.inferredType);
    if (numeric && DPD_RE.test(c.name) && free(`${c.name} Bucket`)) {
      ops.push(
        op(
          {
            op: 'addColumn',
            name: `${c.name} Bucket`,
            spec: { kind: 'bucket', column: c.name, bounds: [0, 30, 60, 90], labels: ['Current', '1-30 DPD', '31-60 DPD', '61-90 DPD', '90+ DPD'] },
          },
          'Standard delinquency buckets used in collections reporting',
        ),
      );
    }
    if (numeric && SCORE_RE.test(c.name) && typeof c.min === 'number' && typeof c.max === 'number' && c.min >= 250 && c.max <= 900 && free('Score Band')) {
      ops.push(
        op(
          {
            op: 'addColumn',
            name: 'Score Band',
            spec: { kind: 'bucket', column: c.name, bounds: [579, 669, 739, 799], labels: ['Poor (<580)', 'Fair (580-669)', 'Good (670-739)', 'Very Good (740-799)', 'Excellent (800+)'] },
          },
          'Credit-score bands for risk segmentation',
        ),
      );
    }
    if ((c.inferredType === 'date' || c.inferredType === 'datetime') && DOB_RE.test(c.name) && free('Age') && free('Age Band')) {
      ops.push(op({ op: 'addColumn', name: 'Age', spec: { kind: 'datePart', column: c.name, part: 'age' } }, 'Age in years from date of birth'));
      ops.push(
        op(
          { op: 'addColumn', name: 'Age Band', spec: { kind: 'bucket', column: 'Age', bounds: [25, 35, 45, 55], labels: ['18-25', '26-35', '36-45', '46-55', '56+'] } },
          'Age groups for customer segmentation',
        ),
      );
    }
  }
  return ops;
}

// ---------- model ----------

function distinctCount(rows: unknown[][], i: number) {
  return new Set(rows.map((r) => (r[i] === null ? null : String(r[i]).toLowerCase())).filter((v) => v !== null)).size;
}

const EVENT_DATE_RE = /order|sale|transaction|invoice|open|disburs|start|booking|created|posted|payment/i;
const isDateCol = (c: CleanedColumn) => c.type === 'date' || c.type === 'datetime';

/** "Customer Dataset" → "Customer", "loan_data" → "Loan". */
function niceTableName(name: string) {
  const stripped = name.replace(/\s+(dataset|data|table|sheet|details|master)$/i, '').trim();
  return stripped || name;
}

type PipeInfo = { headers: string[]; rows: unknown[][]; columns: CleanedColumn[] };

export function modelRules(project: Project, pipelines: Map<string, PipeInfo>): ModelSpec {
  const names = project.tables.map((t) => t.name);
  const pipe = (n: string) => pipelines.get(n)!;

  // Columns that uniquely identify a row (candidate keys).
  const unique = new Map<string, Set<string>>();
  for (const n of names) {
    const p = pipe(n);
    unique.set(
      n,
      new Set(
        p.headers.filter((h, i) => {
          if (!p.rows.length) return false;
          const nonNull = p.rows.filter((r) => r[i] !== null && r[i] !== '').length;
          return nonNull === p.rows.length && distinctCount(p.rows, i) === p.rows.length;
        }),
      ),
    );
  }
  // Shared columns that look like keys (IDs / text), not shared measures like "Amount".
  const sharedKeys = (a: string, b: string) =>
    pipe(a).columns.filter((c) => pipe(b).headers.includes(c.name) && (isIdLikeName(c.name) || c.type === 'text')).map((c) => c.name);

  const relationships: Relationship[] = [];
  const roles = new Map<string, 'fact' | 'dimension'>(names.map((n) => [n, 'fact']));
  const oneToOne: { a: string; b: string; keys: string[] }[] = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      const keys = sharedKeys(a, b);
      const both: string[] = [];
      for (const k of keys) {
        const ua = unique.get(a)!.has(k);
        const ub = unique.get(b)!.has(k);
        if (ua && !ub) {
          roles.set(a, 'dimension');
          relationships.push({ fromTable: b, fromColumn: k, toTable: a, toColumn: k });
        } else if (ub && !ua) {
          roles.set(b, 'dimension');
          relationships.push({ fromTable: a, fromColumn: k, toTable: b, toColumn: k });
        } else if (ua && ub) both.push(k);
      }
      if (both.length) oneToOne.push({ a, b, keys: both });
    }
  }

  // Tables only linked one-to-one (e.g. Loans / Customers / Bureau, one row per customer):
  // the most "transactional" one becomes the fact, the others describe it.
  const linked = (n: string) => relationships.some((r) => r.fromTable === n || r.toTable === n);
  const pairs = oneToOne.filter((p) => !linked(p.a) && !linked(p.b));
  if (pairs.length) {
    const score = (n: string) => {
      const cols = pipe(n).columns;
      return (
        pairs.filter((p) => p.a === n || p.b === n).reduce((s, p) => s + p.keys.length, 0) +
        (cols.some((c) => isDateCol(c) && !DOB_RE.test(c.name)) ? 2 : 0) +
        cols.filter((c) => NUMERIC.has(c.type) && MONEY_RE.test(c.name)).length * 0.5 +
        pipe(n).rows.length / 1e9
      );
    };
    const candidates = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort((x, y) => score(y) - score(x));
    const fact = candidates[0];
    for (const p of pairs) {
      const dim = p.a === fact ? p.b : p.b === fact ? p.a : null;
      if (!dim || relationships.some((r) => r.toTable === dim)) continue;
      const word = niceTableName(dim).split(/\s+/)[0].toLowerCase();
      const key = p.keys.find((k) => k.toLowerCase().includes(word)) ?? p.keys.find((k) => isIdLikeName(k)) ?? p.keys[0];
      roles.set(dim, 'dimension');
      relationships.push({ fromTable: fact, fromColumn: key, toTable: dim, toColumn: key });
    }
  }

  // Friendly, unique model table names.
  const taken = new Set<string>();
  const display = new Map<string, string>();
  for (const n of names) {
    let nice = niceTableName(n);
    if (taken.has(nice.toLowerCase()) || ['date', 'calendar', '_measures', 'datafolder'].includes(nice.toLowerCase())) nice = n;
    taken.add(nice.toLowerCase());
    display.set(n, nice);
  }

  const tables: ModelTable[] = names.map((n) => {
    const role = roles.get(n)!;
    const key = role === 'dimension' ? relationships.find((r) => r.toTable === n)?.toColumn : undefined;
    return { name: display.get(n)!, role, source: n, columns: [...pipe(n).headers], key };
  });
  const rels = relationships.map((r) => ({ ...r, fromTable: display.get(r.fromTable)!, toTable: display.get(r.toTable)! }));

  let dateTable = { enabled: false, name: 'Date', table: '', column: '' };
  const ordered = [...tables.filter((t) => t.role === 'fact'), ...tables.filter((t) => t.role === 'dimension')];
  for (const t of ordered) {
    const dates = pipe(t.source).columns.filter((c) => isDateCol(c) && !DOB_RE.test(c.name));
    if (dates.length) {
      dateTable = { enabled: true, name: 'Date', table: t.name, column: (dates.find((c) => EVENT_DATE_RE.test(c.name)) ?? dates[0]).name };
      break;
    }
  }
  return { tables, relationships: rels, dateTable, source: 'rules' };
}

// ---------- measures ----------

export function measureRules(project: Project, model: ModelSpec): MeasureSpec[] {
  const cols = modelColumns(project, model);
  const allColumnNames = new Set([...cols.values()].flat().map((c) => c.name.toLowerCase()));
  const measures: MeasureSpec[] = [];
  const taken = (n: string) => allColumnNames.has(n.toLowerCase()) || measures.some((x) => x.name.toLowerCase() === n.toLowerCase());
  const add = (m: MeasureSpec) => {
    let name = m.name;
    let i = 2;
    if (taken(name)) {
      name = `${m.name} Measure`;
      while (taken(name)) name = `${m.name} Measure ${i++}`;
    }
    measures.push({ ...m, name });
  };

  const facts = model.tables.filter((t) => t.role === 'fact');
  const dims = model.tables.filter((t) => t.role === 'dimension');
  const sums: MeasureSpec[] = [];
  const plural = (s: string) => (/s$/i.test(s) ? s : `${s}s`);
  const last = () => measures[measures.length - 1];

  /** Measures for a table's numeric columns: flags → rate + count, rates/scores/days → average, amounts → sum. */
  const numericMeasures = (table: string, tc: CleanedColumn[], maxSums: number, sumsOnlyMoney: boolean) => {
    const numeric = tc.filter((c) => (NUMERIC.has(c.type) || c.type === 'boolean') && !isIdLikeName(c.name) && !/ sort$/i.test(c.name));
    numeric.sort((a, b) => Number(MONEY_RE.test(b.name)) - Number(MONEY_RE.test(a.name)));
    for (const c of numeric.filter((c) => FLAG_RE.test(c.name))) {
      const base = c.name.replace(/\s*flag$/i, '').trim() || c.name;
      add({
        name: `${base} Rate`,
        expression: `AVERAGE(${daxColumn(table, c.name)})`,
        formatString: '0.0%',
        displayFolder: 'Ratios',
        description: `Share of records where ${c.name} = 1`,
      });
      add({
        name: `${base} Count`,
        expression: `SUM(${daxColumn(table, c.name)})`,
        formatString: '#,0',
        displayFolder: 'Base',
        description: `Number of records where ${c.name} = 1`,
      });
    }
    const rest = numeric.filter((c) => !FLAG_RE.test(c.name));
    // Rates, percentages, scores and day counts are averaged, never summed.
    for (const c of rest.filter((c) => RATE_RE.test(c.name)).slice(0, 3)) {
      add({
        name: `Average ${c.name}`,
        expression: `AVERAGE(${daxColumn(table, c.name)})`,
        formatString: /discount|percent|pct|rate|margin/i.test(c.name) ? '0.0%' : '#,0.0',
        displayFolder: 'Base',
        description: `Average ${c.name}`,
      });
    }
    const summable = rest.filter((c) => !RATE_RE.test(c.name) && (!sumsOnlyMoney || MONEY_RE.test(c.name)));
    for (const c of summable.slice(0, maxSums)) {
      add({
        // "Total Outstanding" is already a total: prefix the table instead of "Total Total …".
        name: /^total\s/i.test(c.name) ? `${table} ${c.name}` : `Total ${c.name}`,
        expression: `SUM(${daxColumn(table, c.name)})`,
        formatString: c.type === 'integer' ? '#,0' : '#,0.00',
        displayFolder: 'Base',
        description: `Sum of ${c.name}`,
      });
      sums.push(last());
    }
    return summable;
  };

  for (const f of facts) {
    const fc = cols.get(f.name) ?? [];
    // Count the fact's own entity ("Loan ID" in "Loan Performance" → "Total Loans").
    const word = f.name.split(/\s+/)[0].toLowerCase();
    const idCol = fc.find((c) => isIdLikeName(c.name) && c.name.toLowerCase().startsWith(word));
    const entity = idCol ? plural(idCol.name.replace(/\s*(id|key|code|no|number)$/i, '').trim()) : '';
    add({
      name: facts.length > 1 ? `${f.name} Count` : entity ? `Total ${entity}` : 'Total Records',
      expression: `COUNTROWS(${daxTable(f.name)})`,
      formatString: '#,0',
      displayFolder: 'Base',
      description: `Number of rows in ${f.name}`,
    });
    const countMeasure = last();
    const summable = numericMeasures(f.name, fc, 5, false);
    const first = summable[0];
    if (first) {
      add({
        name: `Average ${first.name}`,
        expression: `AVERAGE(${daxColumn(f.name, first.name)})`,
        formatString: '#,0.00',
        displayFolder: 'Base',
        description: `Average ${first.name} per row`,
      });
    }
    for (const c of fc.filter((c) => c !== idCol && isIdLikeName(c.name) && /customer|order|client|user|invoice|transaction|product/i.test(c.name)).slice(0, 2)) {
      add({
        name: `Distinct ${plural(c.name.replace(/\s*(id|key|code)$/i, '').trim() || c.name)}`,
        expression: `DISTINCTCOUNT(${daxColumn(f.name, c.name)})`,
        formatString: '#,0',
        displayFolder: 'Base',
        description: `Number of unique ${c.name}`,
      });
    }

    // Collections / credit-risk pack when there is a days-past-due column.
    const dpd = fc.find((c) => NUMERIC.has(c.type) && DPD_RE.test(c.name));
    if (dpd) {
      const T = daxTable(f.name);
      const D = daxColumn(f.name, dpd.name);
      const noun = countMeasure.name.replace(/^Total /, '').replace(/ Count$/, '');
      const outstanding = sums.find((m) => /outstanding|balance|exposure|principal/i.test(m.name) && m.expression.includes(T));
      add({ name: `Delinquent ${noun}`, expression: `CALCULATE(COUNTROWS(${T}), ${D} > 0)`, formatString: '#,0', displayFolder: 'Collections', description: `${noun} with ${dpd.name} above 0` });
      const delinquent = last();
      add({
        name: 'Delinquency %',
        expression: `DIVIDE(${daxMeasureRef(delinquent.name)}, ${daxMeasureRef(countMeasure.name)})`,
        formatString: '0.0%',
        displayFolder: 'Collections',
        description: `Share of ${noun.toLowerCase()} that are past due`,
      });
      add({ name: `NPA ${noun} (90+ DPD)`, expression: `CALCULATE(COUNTROWS(${T}), ${D} > 90)`, formatString: '#,0', displayFolder: 'Collections', description: `Non-performing: more than 90 days past due` });
      const npa = last();
      add({
        name: 'NPA %',
        expression: `DIVIDE(${daxMeasureRef(npa.name)}, ${daxMeasureRef(countMeasure.name)})`,
        formatString: '0.0%',
        displayFolder: 'Collections',
        description: `Share of ${noun.toLowerCase()} more than 90 days past due`,
      });
      if (outstanding) {
        const col = outstanding.expression.match(/SUM\((.*)\)$/)?.[1];
        add({
          name: 'Overdue Outstanding',
          expression: `CALCULATE(SUM(${col}), ${D} > 0)`,
          formatString: outstanding.formatString,
          displayFolder: 'Collections',
          description: `${outstanding.name.replace(/^Total /, '')} on past-due ${noun.toLowerCase()}`,
        });
        add({
          name: 'Overdue Outstanding %',
          expression: `DIVIDE([Overdue Outstanding], ${daxMeasureRef(outstanding.name)})`,
          formatString: '0.0%',
          displayFolder: 'Collections',
          description: 'Share of the outstanding balance that is past due',
        });
      }
    }
  }

  // Descriptive tables (customers, bureau, …) still carry useful numbers.
  for (const d of dims) numericMeasures(d.name, cols.get(d.name) ?? [], 3, true);

  const primary = sums.find((m) => PRIMARY_RE.test(m.name)) ?? sums[0];
  const profit = sums.find((m) => /profit|margin/i.test(m.name));
  if (primary && profit && profit !== primary) {
    add({
      name: 'Profit Margin %',
      expression: `DIVIDE(${daxMeasureRef(profit.name)}, ${daxMeasureRef(primary.name)})`,
      formatString: '0.0%',
      displayFolder: 'Ratios',
      description: `${profit.name} as a share of ${primary.name}`,
    });
  }
  const orders = measures.find((m) => /order/i.test(m.name) && m.expression.startsWith('DISTINCTCOUNT'));
  if (primary && orders) {
    add({
      name: 'Average Order Value',
      expression: `DIVIDE(${daxMeasureRef(primary.name)}, ${daxMeasureRef(orders.name)})`,
      formatString: '#,0.00',
      displayFolder: 'Ratios',
      description: `${primary.name} per order`,
    });
  }

  if (primary && model.dateTable.enabled) {
    const d = daxColumn(model.dateTable.name, 'Date');
    const p = daxMeasureRef(primary.name);
    const base = primary.name.replace(/^Total /, '');
    add({ name: `${base} YTD`, expression: `TOTALYTD(${p}, ${d})`, formatString: primary.formatString, displayFolder: 'Time Intelligence', description: `Year-to-date ${base}` });
    add({
      name: `${base} PY`,
      expression: `CALCULATE(${p}, SAMEPERIODLASTYEAR(${d}))`,
      formatString: primary.formatString,
      displayFolder: 'Time Intelligence',
      description: `${base} in the same period last year`,
    });
    add({
      name: `${base} YoY %`,
      expression: `VAR Curr = ${p}\nVAR Prev = ${daxMeasureRef(`${base} PY`)}\nRETURN\n    IF(NOT ISBLANK(Prev), DIVIDE(Curr - Prev, Prev))`,
      formatString: '0.0%',
      displayFolder: 'Time Intelligence',
      description: `Year-over-year growth of ${base}`,
    });
    add({
      name: `${base} MoM %`,
      expression: `VAR Curr = ${p}\nVAR Prev = CALCULATE(${p}, DATEADD(${d}, -1, MONTH))\nRETURN\n    IF(NOT ISBLANK(Prev), DIVIDE(Curr - Prev, Prev))`,
      formatString: '0.0%',
      displayFolder: 'Time Intelligence',
      description: `Month-over-month growth of ${base}`,
    });
  }
  return measures;
}

// ---------- report ----------

interface CategoryCandidate {
  table: string;
  column: string;
  distinct: number;
  score: number;
}

export function categoryCandidates(project: Project, model: ModelSpec): CategoryCandidate[] {
  const data = buildModelData(project, model);
  const cols = modelColumns(project, model);
  const out: CategoryCandidate[] = [];
  for (const t of model.tables) {
    const d = data.get(t.name);
    if (!d) continue;
    for (const c of cols.get(t.name) ?? []) {
      if (c.type !== 'text' || isIdLikeName(c.name)) continue;
      if (/name|description|comment|note|address|email|phone/i.test(c.name) && !CATEGORY_RE.test(c.name)) continue;
      const distinct = distinctCount(d.rows, d.headers.indexOf(c.name));
      if (distinct < 2 || distinct > 60) continue;
      const score = (CATEGORY_RE.test(c.name) ? 10 : 0) + (TOP_CATEGORY_RE.test(c.name) ? 4 : 0) + (distinct <= 12 ? 3 : 0) - distinct / 30;
      out.push({ table: t.name, column: c.name, distinct, score });
    }
  }
  // Same-named columns can exist in fact and dimension; prefer the dimension.
  const byName = new Map<string, CategoryCandidate>();
  for (const c of out.sort((a, b) => b.score - a.score)) {
    const existing = byName.get(c.column);
    const isDim = model.tables.find((t) => t.name === c.table)?.role === 'dimension';
    if (!existing || isDim) byName.set(c.column, c);
  }
  return [...byName.values()].sort((a, b) => b.score - a.score);
}

const measureRef = (name: string): FieldRef => ({ kind: 'measure', table: MEASURE_TABLE, name });
const colRef = (table: string, name: string): FieldRef => ({ kind: 'column', table, name });

export function reportRules(project: Project, model: ModelSpec, measures: MeasureSpec[]): ReportSpec {
  const visuals: VisualSpec[] = [];
  const v = (type: VisualSpec['type'], title: string, fields: VisualSpec['fields'], sortDescending?: boolean) =>
    visuals.push({ id: newId(), type, title, fields, sortDescending });

  const base = measures.filter((m) => m.displayFolder !== 'Time Intelligence');
  const sums = base.filter((m) => m.expression.startsWith('SUM('));
  const primary = sums.find((m) => PRIMARY_RE.test(m.name)) ?? sums[0] ?? base[0];
  const yoy = measures.find((m) => /YoY/i.test(m.name));
  // [pattern, how many cards it may fill] — one headline number per theme, then risk/quality ratios.
  const priority: [RegExp, number][] = [
    [/^total .*(profit|outstanding|balance)$/i, 1],
    [/margin|delinquency %|npa %|default rate|churn rate/i, 2],
    [/^total \w+s$|distinct (order|customer)s/i, 1],
    [/average .*score|quantity|qty|units/i, 1],
  ];
  const ranked = priority.flatMap(([re, n]) => base.filter((m) => m !== primary && re.test(m.name)).slice(0, n));
  const ratios = base.filter((m) => m.formatString.includes('%') && m.displayFolder !== 'Base');
  const cards = [primary, ...ranked, ...base.filter((m) => m !== primary)]
    .filter((m, i, arr) => m && arr.indexOf(m) === i)
    .slice(0, 5);
  if (yoy) cards.push(yoy);
  for (const m of cards) v('card', m.name, [{ role: 'Values', field: measureRef(m.name) }]);

  const cats = categoryCandidates(project, model);
  const dt = model.dateTable;
  if (primary) {
    if (dt.enabled) {
      v('lineChart', `${primary.name} by Month`, [
        { role: 'Category', field: colRef(dt.name, 'Year Month') },
        { role: 'Y', field: measureRef(primary.name) },
      ]);
    }
    if (cats[0]) {
      v('clusteredBarChart', `${primary.name} by ${cats[0].column}`, [
        { role: 'Category', field: colRef(cats[0].table, cats[0].column) },
        { role: 'Y', field: measureRef(primary.name) },
      ], true);
    }
    const second = sums.find((m) => m !== primary) ?? primary;
    if (cats[1]) {
      v('clusteredColumnChart', `${second.name} by ${cats[1].column}`, [
        { role: 'Category', field: colRef(cats[1].table, cats[1].column) },
        { role: 'Y', field: measureRef(second.name) },
      ], true);
    }
    const small = cats.find((c) => c.distinct <= 8 && c !== cats[0] && c !== cats[1]) ?? cats.find((c) => c.distinct <= 8);
    if (small) {
      v('donutChart', `${primary.name} share by ${small.column}`, [
        { role: 'Category', field: colRef(small.table, small.column) },
        { role: 'Y', field: measureRef(primary.name) },
      ]);
    }
    // A risk/quality ratio across a banded attribute, e.g. Delinquency % by Score Band.
    const ratio = ratios[0];
    const bands = cats.filter((c) => /band|bucket|grade|tier/i.test(c.column) && c !== cats[1]);
    const band = bands.find((c) => /score|risk|grade|rating/i.test(c.column)) ?? bands[0];
    if (ratio && band) {
      v('clusteredColumnChart', `${ratio.name} by ${band.column}`, [
        { role: 'Category', field: colRef(band.table, band.column) },
        { role: 'Y', field: measureRef(ratio.name) },
      ]);
    }
    if (cats[0]) {
      const values = [primary, second, ...ratios.slice(0, 2), ...base.filter((m) => m !== primary)]
        .filter((m, i, arr) => arr.indexOf(m) === i)
        .slice(0, 4);
      v('pivotTable', `${cats[0].column} details`, [
        { role: 'Rows', field: colRef(cats[0].table, cats[0].column) },
        ...values.map((m) => ({ role: 'Values', field: measureRef(m.name) })),
      ]);
    }
  }

  if (dt.enabled) v('slicer', 'Year', [{ role: 'Values', field: colRef(dt.name, 'Year') }]);
  for (const c of cats.slice(0, 3)) v('slicer', c.column, [{ role: 'Values', field: colRef(c.table, c.column) }]);

  return {
    title: `${project.name}`,
    subtitle: project.analysis?.dashboardIdea ? 'Interactive overview — use the slicers on the left to filter' : '',
    visuals,
    theme: DEFAULT_THEME,
    source: 'rules',
  };
}
