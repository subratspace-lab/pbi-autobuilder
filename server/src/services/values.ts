import type { Cell, ColumnType, Culture } from '../../../shared/types.js';

// Value parsing that mirrors what Power Query does with Table.TransformColumnTypes
// closely enough for previews and validation totals.

const NUMBER_RE = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][+-]?\d+)?$/;
const CURRENCY_RE = /^[+-]?\s*[$€£₹¥]\s*[\d,]+(\.\d+)?$|^[\d,]+(\.\d+)?\s*[$€£₹¥]$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isBlank(v: Cell): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

export function parseNumber(v: Cell): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  const s = v.trim();
  if (s === '' || !/\d/.test(s) || !NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function looksLikeCurrency(v: Cell): boolean {
  return typeof v === 'string' && CURRENCY_RE.test(v.trim());
}

function pad(n: number, len = 2) {
  return String(n).padStart(len, '0');
}

function validDate(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fixYear(y: number) {
  return y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
}

/** Parses a date/datetime string. Returns ISO "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss". */
export function parseDate(v: Cell, culture: Culture = 'en-US'): string | null {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return null;
  const s = v.trim();
  if (s === '') return null;
  let y: number, m: number, d: number;
  let time = '';
  const timePart = (rest: string | undefined) => {
    if (!rest) return '';
    const t = rest.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm)?/i);
    if (!t) return null;
    let h = Number(t[1]);
    if (t[4]) {
      const pm = t[4].toLowerCase() === 'pm';
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    if (h > 23) return null;
    return `T${pad(h)}:${t[2]}:${t[3] ?? '00'}`;
  };

  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](.*))?$/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const t = timePart(match[4]?.replace(/Z$|[+-]\d{2}:?\d{2}$/, ''));
    if (t === null) return null;
    time = t;
  } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s+(.*))?$/))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = fixYear(Number(match[3]));
    [m, d] = culture === 'en-GB' ? [b, a] : [a, b];
    const t = timePart(match[4]);
    if (t === null) return null;
    time = t;
  } else if ((match = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{2,4})$/))) {
    d = Number(match[1]);
    m = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    y = fixYear(Number(match[3]));
  } else if ((match = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    m = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    d = Number(match[2]);
    y = Number(match[3]);
  } else {
    return null;
  }
  if (!validDate(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}${time && time !== 'T00:00:00' ? time : ''}`;
}

/** Guess whether day-first dates are used: any first part > 12 with second part <= 12. */
export function detectCulture(values: Cell[]): Culture {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = v.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst++;
    if (Number(m[2]) > 12) monthFirst++;
  }
  return dayFirst > monthFirst ? 'en-GB' : 'en-US';
}

export function parseBoolean(v: Cell): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** Convert a value the way Table.TransformColumnTypes + ReplaceErrorValues(null) would. */
export function convertValue(v: Cell, type: ColumnType, culture: Culture): Cell {
  if (v === null) return null;
  switch (type) {
    case 'text':
      return typeof v === 'string' ? v : String(v);
    case 'number':
    case 'currency': {
      // Strict on purpose: symbols must be removed by an explicit cleaning step,
      // exactly as Power Query requires.
      const n = parseNumber(v);
      return type === 'currency' && n !== null ? Math.round(n * 10000) / 10000 : n;
    }
    case 'integer': {
      const n = parseNumber(v);
      return n === null ? null : Math.round(n);
    }
    case 'boolean':
      return parseBoolean(v);
    case 'date': {
      const d = parseDate(v, culture);
      return d ? d.slice(0, 10) : null;
    }
    case 'datetime': {
      const d = parseDate(v, culture);
      return d ? (d.length === 10 ? `${d}T00:00:00` : d) : null;
    }
  }
}

const ID_NAME_RE = /(^|[\s_])(id|key|code|zip|postal|pin|phone|mobile|sku)($|[\s_])|(id|key|code)$/i;

// "Loan Account No", "Customer PAN No", "Invoice Number" — but not "No of Loans".
const ID_SUFFIX_RE = /\s(no|number|num|account|pan|aadhaar|ssn)\.?$/i;

export function isIdLikeName(name: string) {
  return ID_NAME_RE.test(name) || /\bID\b/.test(name) || ID_SUFFIX_RE.test(name.trim());
}

/** Infer the best Power BI type for a column from its values. */
export function inferType(name: string, values: Cell[], culture: Culture): ColumnType {
  let nonBlank = 0;
  let nums = 0;
  let ints = 0;
  let dates = 0;
  let datetimes = 0;
  let bools = 0;
  let leadingZero = 0;
  for (const v of values) {
    if (isBlank(v)) continue;
    nonBlank++;
    if (typeof v === 'boolean' || parseBoolean(v) !== null) {
      bools++;
      continue;
    }
    const n = parseNumber(v);
    if (n !== null) {
      nums++;
      if (Number.isInteger(n)) ints++;
      if (typeof v === 'string' && /^0\d/.test(v.trim())) leadingZero++;
      continue;
    }
    const d = parseDate(v, culture);
    if (d) {
      dates++;
      if (d.length > 10) datetimes++;
    }
  }
  if (nonBlank === 0) return 'text';
  const share = (x: number) => x / nonBlank;
  if (share(bools) >= 0.98) return 'boolean';
  if (share(nums) >= 0.98) {
    if (isIdLikeName(name) || leadingZero > 0) return 'text';
    return ints === nums ? 'integer' : 'number';
  }
  if (share(dates) >= 0.95) return datetimes > 0 ? 'datetime' : 'date';
  return 'text';
}

export function cellToString(v: Cell): string {
  if (v === null) return '';
  return String(v);
}
