import { describe, expect, it } from 'vitest';
import type { CleaningOp, SourceTable } from '../../../shared/types.js';
import { runPipeline, properCase } from './cleaning.js';
import { lintMeasures, evaluateMeasure } from './dax.js';
import { parseDate, parseNumber, inferType } from './values.js';
import { excelSerialToIso, isDateFormat } from './ingest.js';
import { embeddedSourceSteps } from './tmdl.js';
import zlib from 'node:zlib';

const table: SourceTable = { name: 'Orders', file: 'orders.csv', kind: 'csv', delimiter: ',', rowCount: 4, headers: [] };
const raw = {
  headers: ['Order ID', 'Order Date', 'Region', 'Sales', 'Cost'],
  rows: [
    ['A1', '01/15/2024', ' east ', '$1,200.50', '700'],
    ['A2', '02/03/2024', 'West', '300', '120'],
    ['A2', '02/03/2024', 'West', '300', '120'],
    ['', '', '', '', ''],
  ],
};
let n = 0;
type OpInput = CleaningOp extends infer T ? (T extends CleaningOp ? Omit<T, 'id' | 'enabled'> : never) : never;
const op = (o: OpInput) => ({ id: `op${n++}`, enabled: true, ...o }) as CleaningOp;

describe('values', () => {
  it('parses numbers and dates like Power Query (en-US)', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('12abc')).toBeNull();
    expect(parseDate('01/15/2024', 'en-US')).toBe('2024-01-15');
    expect(parseDate('15/01/2024', 'en-GB')).toBe('2024-01-15');
    expect(parseDate('2024-01-15T10:30:00')).toBe('2024-01-15T10:30:00');
    expect(parseDate('5-Jan-2024')).toBe('2024-01-05');
  });
  it('keeps ID-like numeric columns as text', () => {
    expect(inferType('Customer ID', ['1', '2'], 'en-US')).toBe('text');
    expect(inferType('Quantity', ['1', '2'], 'en-US')).toBe('integer');
  });
  it('proper-cases like Text.Proper', () => {
    expect(properCase("o'neil SMITH-jones")).toBe("O'Neil Smith-Jones");
  });
});

describe('embedded data source', () => {
  it('round-trips rows through base64 + raw deflate + JSON (what Power Query decodes)', () => {
    const rows = [
      ['L001', 1250000.5, '2024-01-05', null, true],
      ['L002 "quoted"', 0, 'naïve ₹', '', false],
    ];
    const steps = embeddedSourceSteps({ headers: ['Loan ID', 'Amount', 'Date', 'Note', 'Flag'], rows });
    expect(steps.map((s) => s.name)).toEqual(['Source', 'Promoted Headers']);
    expect(steps[0].expr).toMatch(/^Binary\.Decompress\(Binary\.FromText\(Text\.Combine\(\{"/);
    expect(steps[1].expr).toBe('Table.FromRows(Json.Document(#"Source", 65001), {"Loan ID", "Amount", "Date", "Note", "Flag"})');
    const b64 = [...steps[0].expr.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((m) => m[1]).join('');
    expect(JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8'))).toEqual(rows);
  });
});

describe('excel dates', () => {
  it('detects date formats and converts serials', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('[$-409]mmmm d, yyyy')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat('0%')).toBe(false);
    expect(excelSerialToIso(45296)).toBe('2024-01-05');
    expect(excelSerialToIso(45296.5)).toBe('2024-01-05T12:00:00');
  });
});

describe('cleaning pipeline', () => {
  const result = runPipeline(table, raw, {
    table: 'Orders',
    culture: 'en-US',
    ops: [
      op({ op: 'removeBlankRows' }),
      op({ op: 'trim', columns: ['Region'] }),
      op({ op: 'properCase', columns: ['Region'] }),
      op({ op: 'replaceValues', column: 'Sales', find: '$', replace: '', wholeValue: false }),
      op({ op: 'setType', column: 'Sales', type: 'number' }),
      op({ op: 'setType', column: 'Order Date', type: 'date' }),
      op({ op: 'addColumn', name: 'Profit', spec: { kind: 'arithmetic', left: 'Sales', operator: '-', right: 'Cost' } }),
      op({ op: 'removeDuplicates' }),
      op({ op: 'rename', from: 'Missing', to: 'X' }),
    ],
  });

  it('applies the steps in JS', () => {
    expect(result.rowsBefore).toBe(4);
    expect(result.rowsAfter).toBe(2);
    expect(result.previewAfter.rows[0]).toEqual(['A1', '2024-01-15', 'East', 1200.5, 700, 500.5]);
    expect(result.columns.map((c) => c.type)).toEqual(['text', 'date', 'text', 'number', 'integer', 'number']);
  });

  it('skips steps that reference missing columns', () => {
    expect(result.warnings.some((w) => w.includes('Missing'))).toBe(true);
  });

  it('emits matching Power Query M', () => {
    expect(result.m).toMatchSnapshot();
    expect(result.m).toContain('Csv.Document(File.Contents(DataFolder & "orders.csv")');
    expect(result.m).toContain('Table.ReplaceValue(#"Capitalized Region", "$", "", Replacer.ReplaceText, {"Sales"})');
    expect(result.m.trim().endsWith('#"Replaced Conversion Errors"')).toBe(true);
  });
});

describe('DAX lint & evaluator', () => {
  const tables = new Map([['Sales', [{ name: 'Amount', type: 'number' as const }, { name: 'Region', type: 'text' as const }]]]);
  const measures = [
    { name: 'Total Amount', expression: "SUM('Sales'[Amount])", formatString: '', displayFolder: '', description: '' },
    { name: 'Avg', expression: 'DIVIDE([Total Amount], [Rows])', formatString: '', displayFolder: '', description: '' },
    { name: 'Rows', expression: "COUNTROWS('Sales')", formatString: '', displayFolder: '', description: '' },
    { name: 'Bad', expression: "SUM('Sales'[Nope]) + (1", formatString: '', displayFolder: '', description: '' },
  ];

  it('flags missing columns and unbalanced parentheses', () => {
    const issues = lintMeasures(measures, tables, '_Measures');
    const bad = issues.filter((i) => i.measure === 'Bad').map((i) => i.message);
    expect(bad).toContain('Unbalanced parentheses');
    expect(bad.some((m) => m.includes('Nope'))).toBe(true);
    expect(issues.filter((i) => i.measure !== 'Bad')).toEqual([]);
  });

  it('evaluates simple measures', () => {
    const ctx = {
      measures,
      model: { tables: [], relationships: [], dateTable: { enabled: false, name: 'Date', table: '', column: '' }, source: 'user' as const },
      rowsOf: () => ({ headers: ['Amount', 'Region'], rows: [[10, 'A'], [30, 'B']] }),
    };
    expect(evaluateMeasure('Total Amount', ctx)).toBe(40);
    expect(evaluateMeasure('Avg', ctx)).toBe(20);
    expect(evaluateMeasure('Bad', ctx)).toBeNull();
  });
});
