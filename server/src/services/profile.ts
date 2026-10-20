import type { Cell, ColumnProfile, TableProfile } from '../../../shared/types.js';
import type { RawTable } from './ingest.js';
import { detectCulture, inferType, isBlank, looksLikeCurrency, parseDate, parseNumber } from './values.js';

const TOP_N = 6;

export function profileTable(name: string, raw: RawTable): TableProfile {
  const rowCount = raw.rows.length;
  const allValues = raw.rows.flat();
  const culture = detectCulture(allValues.slice(0, 50000));

  const rowKeys = new Set<string>();
  let duplicateRows = 0;
  let blankRows = 0;
  for (const row of raw.rows) {
    if (row.every(isBlank)) blankRows++;
    const key = JSON.stringify(row);
    if (rowKeys.has(key)) duplicateRows++;
    else rowKeys.add(key);
  }

  const columns = raw.headers.map((header, ci) =>
    profileColumn(
      header,
      raw.rows.map((r) => r[ci]),
      culture,
    ),
  );

  return { table: name, rowCount, duplicateRows, blankRows, culture, columns };
}

function profileColumn(name: string, values: Cell[], culture: 'en-US' | 'en-GB'): ColumnProfile {
  const inferredType = inferType(name, values, culture);
  const counts = new Map<string, number>();
  const normalized = new Map<string, Set<string>>();
  let nulls = 0;
  let whitespace = 0;
  let numericLike = 0;
  let dateLike = 0;
  let currencyLike = 0;
  const symbols = new Set<string>();
  let sum = 0;
  let numCount = 0;
  let min: number | string | undefined;
  let max: number | string | undefined;

  for (const v of values) {
    if (isBlank(v)) {
      nulls++;
      continue;
    }
    const s = String(v);
    counts.set(s, (counts.get(s) ?? 0) + 1);
    if (typeof v === 'string') {
      if (v !== v.trim() || /\s{2,}/.test(v)) whitespace++;
      const norm = v.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!normalized.has(norm)) normalized.set(norm, new Set());
      normalized.get(norm)!.add(v);
      if (looksLikeCurrency(v)) {
        currencyLike++;
        const sym = v.match(/[$€£₹¥]/)?.[0];
        if (sym) symbols.add(sym);
      }
    }
    const n = parseNumber(v);
    if (n !== null) {
      numericLike++;
      sum += n;
      numCount++;
      if (min === undefined || n < (min as number)) min = n;
      if (max === undefined || n > (max as number)) max = n;
      continue;
    }
    const d = parseDate(v, culture);
    if (d) {
      dateLike++;
      if (inferredType === 'date' || inferredType === 'datetime') {
        if (min === undefined || d < (min as string)) min = d;
        if (max === undefined || d > (max as string)) max = d;
      }
    }
  }

  let caseVariants = 0;
  for (const set of normalized.values()) if (set.size > 1) caseVariants += set.size - 1;

  const nonNull = values.length - nulls;
  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([value, count]) => ({ value, count }));

  const issues: string[] = [];
  const pct = (x: number) => (nonNull ? Math.round((x / nonNull) * 100) : 0);
  if (nulls > 0) issues.push(`${nulls} blank/null values (${Math.round((nulls / Math.max(values.length, 1)) * 100)}%)`);
  if (whitespace > 0) issues.push(`${whitespace} values with leading/trailing or double spaces`);
  if (caseVariants > 0) issues.push(`${caseVariants} inconsistent spellings/casing of the same value`);
  if (inferredType === 'text' && numericLike > 0 && pct(numericLike) >= 50 && pct(numericLike) < 100)
    issues.push(`Mostly numeric (${pct(numericLike)}%) but has text values`);
  if (currencyLike > 0) issues.push(`${currencyLike} values contain currency symbols`);
  if (inferredType === 'text' && dateLike > 0 && pct(dateLike) >= 50 && pct(dateLike) < 95)
    issues.push(`Mixed date formats / unparseable dates (${pct(dateLike)}% parse as dates)`);
  const isNumeric = ['number', 'integer', 'currency'].includes(inferredType);
  if (isNumeric && typeof min === 'number' && min < 0) issues.push('Contains negative values');

  return {
    name,
    inferredType,
    count: values.length,
    nulls,
    nullPct: values.length ? Math.round((nulls / values.length) * 1000) / 10 : 0,
    distinct: counts.size,
    topValues,
    min,
    max,
    mean: isNumeric && numCount ? Math.round((sum / numCount) * 100) / 100 : undefined,
    sum: isNumeric ? Math.round(sum * 100) / 100 : undefined,
    samples: [...counts.keys()].slice(0, 8),
    issues,
    stats: { whitespace, caseVariants, numericLike, dateLike, currencyLike, currencySymbols: [...symbols] },
  };
}

/** Compact text version of a profile for LLM prompts (keeps token usage low). */
export function profileForPrompt(profile: TableProfile, sampleRows: { headers: string[]; rows: Cell[][] }) {
  const cols = profile.columns.map((c) => ({
    name: c.name,
    type: c.inferredType,
    nullPct: c.nullPct,
    distinct: c.distinct,
    min: c.min,
    max: c.max,
    top: c.topValues.slice(0, 4).map((t) => t.value),
    issues: c.issues,
  }));
  return {
    table: profile.table,
    rows: profile.rowCount,
    duplicateRows: profile.duplicateRows,
    blankRows: profile.blankRows,
    dateCulture: profile.culture,
    columns: cols,
    sampleRows: sampleRows.rows.slice(0, 15).map((r) => Object.fromEntries(sampleRows.headers.map((h, i) => [h, r[i]]))),
  };
}
