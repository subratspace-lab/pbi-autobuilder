import { describe, expect, it } from 'vitest';
import type { CleaningOp, Relationship, SourceTable } from '../../../shared/types.js';
import { runPipeline, properCase } from './cleaning.js';
import { lintMeasures, evaluateMeasure } from './dax.js';
import { parseDate, parseNumber, inferType } from './values.js';
import { excelSerialToIso, isDateFormat } from './ingest.js';
import { embeddedSourceSteps } from './tmdl.js';
import { deactivateAmbiguousPaths } from './model.js';
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

describe('collections operations', () => {
  const loans = {
    headers: ['Loan ID', 'Customer ID', 'DPD', 'Debt', 'Income'],
    rows: [
      ['L1', 'C1', 0, 20000, 100000],
      ['L2', 'C2', 45, 45000, 60000],
      ['L3', 'C3', 200, 9000, 10000],
    ] as (string | number)[][],
  };
  const bureau = { headers: ['Customer ID', 'Score'], rows: [['C1', 780], ['C2', 640], ['C3', 520]], columns: [{ name: 'Customer ID', type: 'text' as const }, { name: 'Score', type: 'integer' as const }] };
  const ctx = { resolve: (t: string) => (t === 'Bureau' ? bureau : null) };
  const res = runPipeline(
    { ...table, name: 'Loans' },
    loans,
    {
      table: 'Loans',
      culture: 'en-US',
      ops: [
        op({ op: 'mergeTable', table: 'Bureau', leftKey: 'Customer ID', rightKey: 'Customer ID' }),
        op({ op: 'addColumn', name: 'DTI %', spec: { kind: 'arithmetic', left: 'Debt', operator: '/', right: 'Income', scale: 100, round: 2 } }),
        op({ op: 'addColumn', name: 'DPD Score', spec: { kind: 'bucket', column: 'DPD', bounds: [0, 30, 60, 90, 179], labels: [0, 10, 15, 20, 30, 40], numeric: true } }),
        op({ op: 'addColumn', name: 'Score Points', spec: { kind: 'bucket', column: 'Score', bounds: [549, 649, 699, 749], labels: [25, 15, 8, 4, 0], numeric: true } }),
        op({ op: 'addColumn', name: 'Risk', spec: { kind: 'sum', columns: ['DPD Score', 'Score Points'] } }),
        op({ op: 'addColumn', name: 'Bucket', spec: { kind: 'bucket', column: 'DPD', bounds: [0, 30, 60, 90, 180], labels: ['Current', 'SMA-0', 'SMA-1', 'SMA-2', 'NPA', 'Severe NPA'] } }),
        op({
          op: 'addColumn',
          name: 'Critical',
          spec: { kind: 'cases', cases: [{ column: 'Risk', operator: 'greaterThan', value: 60, then: 'Yes' }, { column: 'DPD', operator: 'greaterThan', value: 90, then: 'Yes' }], else: 'No' },
        }),
        op({ op: 'addRank', name: 'Rank', column: 'Risk', descending: true }),
      ],
    },
    ctx,
  );
  const col = (n: string) => res.rows.map((r) => r[res.headers.indexOf(n)]);

  it('merges, scores, bands, flags and ranks', () => {
    expect(res.warnings).toEqual([]);
    expect(col('Score')).toEqual([780, 640, 520]);
    expect(col('DTI %')).toEqual([20, 75, 90]);
    expect(col('Risk')).toEqual([0, 30, 65]);
    expect(col('Bucket')).toEqual(['Current', 'SMA-1', 'Severe NPA']);
    expect(col('Bucket Sort')).toEqual([1, 3, 6]);
    expect(col('Critical')).toEqual(['No', 'No', 'Yes']);
    expect(col('Rank')).toEqual([3, 2, 1]);
    expect(res.columns.find((c) => c.name === 'Bucket')?.sortBy).toBe('Bucket Sort');
    expect(res.columns.find((c) => c.name === 'Risk')?.type).toBe('number');
  });

  it('emits Power Query for the new steps', () => {
    expect(res.m).toContain('Table.NestedJoin(#"Changed Type Order Date"'.replace('Changed Type Order Date', 'Promoted Headers'));
    expect(res.m).toContain('#"Bureau Base", {"Customer ID"}, "__Merged", JoinKind.LeftOuter), "__Merged", {"Score"}, {"Score"})');
    expect(res.m).toContain('Number.Round((if b = 0 then null else a / b) * 100, 2, RoundingMode.AwayFromZero)');
    expect(res.m).toContain('if v <= 549 then 25 else if v <= 649 then 15');
    expect(res.m).toContain('Table.AddRankColumn(#"Added Critical", "Rank", {{"Risk", Order.Descending}}, [RankKind = RankKind.Competition])');
    expect(res.m).toContain('each if (try ([#"Risk"] > 60) = true otherwise false) then "Yes" else if (try ([#"DPD"] > 90) = true otherwise false) then "Yes" else "No"');
  });
});

describe('model relationships', () => {
  const tables = [
    { name: 'POLICY', role: 'fact' as const, source: 'POLICY', columns: [] },
    { name: 'AGENT', role: 'dimension' as const, source: 'AGENT', columns: [] },
    { name: 'BRANCH', role: 'dimension' as const, source: 'BRANCH', columns: [] },
  ];
  const dt = { enabled: true, name: 'Date', table: 'POLICY', column: 'Issue Date' };

  it('deactivates the dimension-to-dimension link that makes paths ambiguous', () => {
    const rels: Relationship[] = [
      { fromTable: 'AGENT', fromColumn: 'Branch ID', toTable: 'BRANCH', toColumn: 'Branch ID' },
      { fromTable: 'POLICY', fromColumn: 'Agent ID', toTable: 'AGENT', toColumn: 'Agent ID' },
      { fromTable: 'POLICY', fromColumn: 'Branch ID', toTable: 'BRANCH', toColumn: 'Branch ID' },
      { fromTable: 'POLICY', fromColumn: 'Issue Date', toTable: 'Date', toColumn: 'Date' },
    ];
    const issues: string[] = [];
    deactivateAmbiguousPaths(rels, tables, dt, issues);
    expect(rels.map((r) => r.active !== false)).toEqual([false, true, true, true]);
    expect(issues[0]).toContain('AGENT[Branch ID] → BRANCH[Branch ID] set to inactive');
  });

  it('keeps only one of two relationships between the same pair', () => {
    const rels: Relationship[] = [
      { fromTable: 'POLICY', fromColumn: 'Agent ID', toTable: 'AGENT', toColumn: 'Agent ID' },
      { fromTable: 'POLICY', fromColumn: 'Referrer ID', toTable: 'AGENT', toColumn: 'Agent ID' },
    ];
    deactivateAmbiguousPaths(rels, tables, { ...dt, enabled: false }, []);
    expect(rels.map((r) => r.active !== false)).toEqual([true, false]);
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
