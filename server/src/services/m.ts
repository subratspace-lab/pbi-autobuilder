import type { ColumnType, Culture } from '../../../shared/types.js';
import { parseDate, parseNumber } from './values.js';

// Helpers for writing Power Query M source code.

export function mString(s: string): string {
  const escaped = s
    .replace(/"/g, '""')
    .replace(/\r/g, '#(cr)')
    .replace(/\n/g, '#(lf)')
    .replace(/\t/g, '#(tab)');
  return `"${escaped}"`;
}

/** Quoted identifier, e.g. #"Order Date". Always quoted so any name is safe. */
export function mId(name: string): string {
  return `#${mString(name)}`;
}

/** Field access inside an `each`, e.g. [#"Order Date"]. */
export function mField(name: string): string {
  return `[${mId(name)}]`;
}

export function mList(items: string[]): string {
  return `{${items.join(', ')}}`;
}

export function mStringList(names: string[]): string {
  return mList(names.map(mString));
}

export function mType(type: ColumnType): string {
  switch (type) {
    case 'text':
      return 'type text';
    case 'number':
      return 'type number';
    case 'integer':
      return 'Int64.Type';
    case 'currency':
      return 'Currency.Type';
    case 'date':
      return 'type date';
    case 'datetime':
      return 'type datetime';
    case 'boolean':
      return 'type logical';
  }
}

export function mNumber(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  return String(n);
}

/** A literal compatible with the column type, so comparisons do not raise errors. */
export function mLiteral(value: unknown, type: ColumnType | undefined, culture: Culture): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (type === 'number' || type === 'integer' || type === 'currency') {
    const n = typeof value === 'number' ? value : parseNumber(String(value));
    if (n !== null) return mNumber(n);
  }
  if (type === 'date' || type === 'datetime') {
    const d = parseDate(String(value), culture);
    if (d) {
      const [y, m, day] = d.slice(0, 10).split('-').map(Number);
      if (type === 'date') return `#date(${y}, ${m}, ${day})`;
      const [hh, mm, ss] = (d.slice(11) || '00:00:00').split(':').map(Number);
      return `#datetime(${y}, ${m}, ${day}, ${hh}, ${mm}, ${ss})`;
    }
  }
  if (typeof value === 'number') return mNumber(value);
  return mString(String(value));
}

export class StepNamer {
  private used = new Set<string>();
  name(base: string): string {
    const clean = base.replace(/[\r\n"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Step';
    let n = clean;
    let i = 2;
    while (this.used.has(n.toLowerCase())) n = `${clean} ${i++}`;
    this.used.add(n.toLowerCase());
    return n;
  }
}

/** Formats a let..in expression from ordered steps. */
export function mLet(steps: { name: string; expr: string }[]): string {
  const body = steps.map((s, i) => `    ${mId(s.name)} = ${s.expr}${i < steps.length - 1 ? ',' : ''}`).join('\n');
  return `let\n${body}\nin\n    ${mId(steps[steps.length - 1].name)}`;
}
