import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type { Cell, SourceTable } from '../../../shared/types.js';

export interface RawTable {
  headers: string[];
  rows: Cell[][];
}

const DATA_EXT = new Set(['.csv', '.txt', '.tsv', '.xlsx', '.xlsm', '.xls']);
const BRIEF_EXT = new Set(['.pdf', '.docx', '.md', '.txt']);

export function isDataFile(name: string) {
  return DATA_EXT.has(path.extname(name).toLowerCase());
}

export function isBriefFile(name: string) {
  return BRIEF_EXT.has(path.extname(name).toLowerCase());
}

/** Mimics Table.PromoteHeaders: empty -> ColumnN, duplicates -> Name_1, Name_2. */
export function promoteHeaders(first: Cell[]): string[] {
  const seen = new Map<string, number>();
  return first.map((h, i) => {
    let name = h === null || String(h).trim() === '' ? `Column${i + 1}` : String(h).trim();
    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count > 0) name = `${name}_${count}`;
    return name;
  });
}

function toRaw(matrix: Cell[][]): RawTable {
  while (matrix.length && matrix[0].every((c) => c === null || c === '')) matrix.shift();
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = promoteHeaders(matrix[0]);
  const width = headers.length;
  const rows = matrix.slice(1).map((r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push(null);
    return row;
  });
  return { headers, rows };
}

export function readCsv(filePath: string): { raw: RawTable; delimiter: string } {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false });
  const data = res.data as Cell[][];
  const last = data[data.length - 1];
  if (last && last.length === 1 && last[0] === '') data.pop();
  // Csv.Document keeps empty fields as "" (not null), so keep them as strings.
  return { raw: toRaw(data), delimiter: res.meta.delimiter || ',' };
}

/** True for Excel number formats that display a date/time (e.g. "m/d/yyyy", "dd-mmm-yy hh:mm"). */
export function isDateFormat(fmt: string): boolean {
  if (!fmt || /^general$/i.test(fmt)) return false;
  const body = fmt
    .replace(/"[^"]*"/g, '') // quoted literals
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '') // [Red], [$-409] etc. (keep elapsed [h])
    .replace(/\\./g, ''); // escaped characters
  return /[dmyhs]/i.test(body) && !/[0#?]/.test(body.replace(/s\.0+/i, ''));
}

/** Excel serial number (1900 date system) → ISO date or datetime. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round(serial * 86400) * 1000 + Date.UTC(1899, 11, 30);
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 19);
  return time === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)}T${time}`;
}

function excelCell(cell: XLSX.CellObject | undefined): Cell {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (cell.t === 'n' && typeof cell.v === 'number') {
    if (isDateFormat((cell.z as string | undefined) ?? '')) return excelSerialToIso(cell.v);
    return cell.v;
  }
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  if (cell.t === 'b') return Boolean(cell.v);
  if (cell.t === 'e') return null;
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

export function readExcelSheets(filePath: string): { sheet: string; raw: RawTable }[] {
  // The ESM build of SheetJS has no readFile(), so parse a buffer instead.
  const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false, cellNF: true });
  return wb.SheetNames.map((sheet) => {
    const ws = wb.Sheets[sheet];
    const ref = ws['!ref'];
    if (!ref) return { sheet, raw: { headers: [], rows: [] } };
    const range = XLSX.utils.decode_range(ref);
    const matrix: Cell[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Cell[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        row.push(excelCell(ws[XLSX.utils.encode_cell({ r, c })]));
      }
      matrix.push(row);
    }
    return { sheet, raw: toRaw(matrix) };
  });
}

function friendlyName(base: string) {
  const cleaned = base
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = cleaned || 'Table';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function uniqueName(name: string, taken: Set<string>) {
  let n = name;
  let i = 2;
  while (taken.has(n.toLowerCase())) n = `${name} ${i++}`;
  taken.add(n.toLowerCase());
  return n;
}

/** Turn an uploaded data file into one or more source tables. */
export function describeDataFile(filePath: string, existing: SourceTable[]): SourceTable[] {
  const file = path.basename(filePath);
  const taken = new Set(existing.map((t) => t.name.toLowerCase()));
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    const sheets = readExcelSheets(filePath).filter((s) => s.raw.headers.length > 0);
    return sheets.map((s) => ({
      name: uniqueName(friendlyName(sheets.length > 1 ? s.sheet : file), taken),
      file,
      kind: 'excel' as const,
      sheet: s.sheet,
      rowCount: s.raw.rows.length,
      headers: s.raw.headers,
    }));
  }
  const { raw, delimiter } = readCsv(filePath);
  return [
    {
      name: uniqueName(friendlyName(file), taken),
      file,
      kind: 'csv',
      delimiter,
      rowCount: raw.rows.length,
      headers: raw.headers,
    },
  ];
}

export function loadRawTable(dataDir: string, table: SourceTable): RawTable {
  const filePath = path.join(dataDir, table.file);
  if (table.kind === 'excel') {
    const sheet = readExcelSheets(filePath).find((s) => s.sheet === table.sheet);
    if (!sheet) throw new Error(`Sheet "${table.sheet}" not found in ${table.file}`);
    return sheet.raw;
  }
  return readCsv(filePath).raw;
}

export async function readBriefFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    // Import the implementation directly: the package index runs a debug harness.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text;
  }
  if (ext === '.docx') {
    const res = await mammoth.extractRawText({ path: filePath });
    return res.value;
  }
  return fs.readFileSync(filePath, 'utf8');
}
