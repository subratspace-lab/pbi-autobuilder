import { describe, expect, it } from 'vitest';
import type { CleaningOp, Relationship, SourceTable } from '../../../shared/types.js';
import { runPipeline, properCase, sourceSteps } from './cleaning.js';
import { lintMeasures, evaluateMeasure } from './dax.js';
import { parseDate, parseNumber, inferType } from './values.js';
import { excelSerialToIso, isDateFormat } from './ingest.js';
import { embeddedSourceSteps } from './tmdl.js';
import { deactivateAmbiguousPaths } from './model.js';
import { translateScript } from './scripts.js';
import { pickChatModel, rankChatModels, testCandidates } from './llm.js';
import { assertReadOnly, detectConnection, quoteTable, scriptPassword } from './sqlserver.js';
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

describe('SQL / Python script translation', () => {
  const headers = ['Order ID', 'OrderDate', 'Qty', 'Price', 'Disc', 'Region', 'Status'];
  const summary = (ops: CleaningOp[]) =>
    ops.map((o) => {
      const { id: _i, enabled: _e, reason: _r, title: _t, ...rest } = o as unknown as Record<string, unknown>;
      return rest;
    });

  it('translates a SQL view', () => {
    const sql = `
      CREATE OR ALTER VIEW dbo.v AS
      WITH c AS (
        SELECT NULLIF(LTRIM(RTRIM([Order ID])), '') AS [Order ID],
               TRY_CONVERT(date, OrderDate) AS OrderDate,
               TRY_CONVERT(int, Qty) AS Qty, TRY_CONVERT(decimal(10,2), Price) AS Price,
               UPPER(NULLIF(LTRIM(RTRIM(Status)), '')) AS Status, Disc, Region,
               ROW_NUMBER() OVER (PARTITION BY [Order ID] ORDER BY OrderDate DESC) AS rn
        FROM stg
      )
      SELECT [Order ID], YEAR(OrderDate) AS OrderYear, COALESCE(Region, 'Unknown') AS Region,
             CAST(Qty * Price AS decimal(14,2)) AS Gross,
             CAST(Qty * Price * COALESCE(Disc, 0) / 100.0 AS decimal(14,2)) AS DiscAmt,
             CAST((Qty * Price) - (Qty * Price * COALESCE(Disc, 0) / 100.0) AS decimal(14,2)) AS Net
      FROM c WHERE rn = 1 AND [Order ID] IS NOT NULL AND Qty > 0;
      GO
      SELECT COUNT(*) FROM dbo.v;`;
    const res = translateScript({ fileName: 'v.sql', language: 'sql', text: sql }, headers);
    expect(summary(res.ops)).toEqual([
      { op: 'trim', columns: ['Order ID', 'Status'] },
      { op: 'emptyToNull', columns: ['Order ID', 'Status'] },
      { op: 'upperCase', columns: ['Status'] },
      { op: 'setType', column: 'OrderDate', type: 'date' },
      { op: 'setType', column: 'Qty', type: 'integer' },
      { op: 'setType', column: 'Price', type: 'number' },
      { op: 'removeRowsWithBlank', column: 'Order ID' },
      { op: 'filterRows', column: 'Qty', operator: 'greaterThan', value: 0 },
      { op: 'removeDuplicates', columns: ['Order ID'] },
      { op: 'replaceNulls', column: 'Region', value: 'Unknown' },
      { op: 'addColumn', name: 'OrderYear', spec: { kind: 'datePart', column: 'OrderDate', part: 'year' } },
      { op: 'addColumn', name: 'Gross', spec: { kind: 'arithmetic', left: 'Qty', operator: '*', right: 'Price', round: 2 } },
      { op: 'addColumn', name: 'DiscAmt', spec: { kind: 'arithmetic', left: 'Gross', operator: '*', right: 'Disc', scale: 0.01, round: 2 } },
      { op: 'addColumn', name: 'Net', spec: { kind: 'arithmetic', left: 'Gross', operator: '-', right: 'DiscAmt', round: 2 } },
    ]);
    expect(res.notes.some((n) => n.includes('extra SELECT'))).toBe(true);
  });

  it('translates a pandas script', () => {
    const py = `
import pandas as pd
df = pd.read_csv("sales.csv")
text_cols = ["Order ID", "Region",
             "Status"]
for col in text_cols:
    df[col] = df[col].astype("string").str.strip()
    df[col] = df[col].replace("", pd.NA)
df["OrderDate"] = pd.to_datetime(df["OrderDate"], errors="coerce")
df = df.dropna(subset=["Order ID", "OrderDate"])
df = df[(df["Qty"] > 0) & (df["Price"] >= 0)]
df = df.drop_duplicates(subset=["Order ID"])
for col, fallback in {"Region": "Unknown"}.items():
    df[col] = df[col].fillna(fallback)
df["Status"] = df["Status"].fillna("UNKNOWN").str.upper()
df["Month"] = df["OrderDate"].dt.strftime("%Y-%m")
df["Gross"] = (df["Qty"] * df["Price"]).round(2)
summary = df.groupby("Region").agg(total=("Gross", "sum"))
`;
    const res = translateScript({ fileName: 't.py', language: 'python', text: py }, headers);
    expect(summary(res.ops)).toEqual([
      { op: 'trim', columns: ['Order ID', 'Region', 'Status'] },
      { op: 'emptyToNull', columns: ['Order ID', 'Region', 'Status'] },
      { op: 'upperCase', columns: ['Status'] },
      { op: 'setType', column: 'OrderDate', type: 'date' },
      { op: 'removeRowsWithBlank', column: 'Order ID' },
      { op: 'removeRowsWithBlank', column: 'OrderDate' },
      { op: 'filterRows', column: 'Qty', operator: 'greaterThan', value: 0 },
      { op: 'filterRows', column: 'Price', operator: 'greaterOrEqual', value: 0 },
      { op: 'removeDuplicates', columns: ['Order ID'] },
      { op: 'replaceNulls', column: 'Region', value: 'Unknown' },
      { op: 'replaceNulls', column: 'Status', value: 'UNKNOWN' },
      { op: 'addColumn', name: 'Month', spec: { kind: 'datePart', column: 'OrderDate', part: 'yearMonth' } },
      { op: 'addColumn', name: 'Gross', spec: { kind: 'arithmetic', left: 'Qty', operator: '*', right: 'Price', round: 2 } },
    ]);
    expect(res.notes.some((n) => n.includes('groupby'))).toBe(true);
  });
});

describe('data sources named inside scripts', () => {
  const sqlScript = (text: string) => ({ fileName: 'x.sql', language: 'sql' as const, text });
  const pyScript = (text: string) => ({ fileName: 'x.py', language: 'python' as const, text });

  it('finds server, database and source tables in SQL', () => {
    const c = detectConnection(
      sqlScript(`-- Server: SQLPROD01
USE [SalesDB];
WITH c AS (SELECT * FROM dbo.Stg_Sales s JOIN [ref].[Region] r ON r.id = s.rid)
SELECT * FROM c; GO
SELECT COUNT(*) FROM dbo.vw_x;
CREATE VIEW dbo.vw_x AS SELECT 1 AS a FROM Archive.dbo.Old_Sales;`),
    );
    expect(c.server).toBe('SQLPROD01');
    expect(c.database).toBe('SalesDB');
    expect(c.tables).toEqual(['dbo.Stg_Sales', 'ref.Region', 'dbo.Old_Sales']);
    expect(c.hasPassword).toBe(false);
  });

  it('reads pyodbc / SQLAlchemy connections and file paths in Python', () => {
    const odbc = detectConnection(pyScript(`conn = pyodbc.connect("DRIVER={ODBC Driver 18 for SQL Server};SERVER=srv01\\\\SQLEXPRESS;DATABASE=Shop;UID=report;PWD=s3cret")
df = pd.read_sql("SELECT * FROM dbo.Orders", conn)`));
    expect([odbc.server, odbc.database, odbc.user, odbc.auth, odbc.hasPassword]).toEqual(['srv01\\\\SQLEXPRESS', 'Shop', 'report', 'sql', true]);
    expect(odbc.tables).toEqual(['dbo.Orders']);
    expect(scriptPassword(pyScript('x = "SERVER=a;PWD=s3cret;"'))).toBe('s3cret');

    const alchemy = detectConnection(pyScript(`engine = create_engine("mssql+pyodbc://@localhost/HR?driver=ODBC+Driver+17&trusted_connection=yes")
df = pd.read_sql_table("Employees", engine, schema="hr")`));
    expect([alchemy.server, alchemy.database, alchemy.auth]).toEqual(['localhost', 'HR', 'windows']);
    expect(alchemy.tables).toEqual(['hr.Employees']);

    const files = detectConnection(pyScript(`BASE = r"C:\\Data\\Shop"
INPUT = Path(BASE) / "sales.csv"
df = pd.read_csv(INPUT)
other = pd.read_excel(r"D:\\x\\targets.xlsx")
rel = pd.read_csv("local.csv")`));
    expect(files.files).toEqual(['C:\\Data\\Shop\\sales.csv', 'D:\\x\\targets.xlsx', 'local.csv']);
  });

  it('only runs read-only queries', () => {
    expect(() => assertReadOnly('SELECT * FROM dbo.Stg_Sales')).not.toThrow();
    expect(() => assertReadOnly('WITH c AS (SELECT 1 AS a) SELECT * FROM c')).not.toThrow();
    expect(() => assertReadOnly("SELECT 'drop table x' AS note")).not.toThrow();
    expect(() => assertReadOnly('DELETE FROM dbo.Stg_Sales')).toThrow();
    expect(() => assertReadOnly('SELECT * INTO t2 FROM t')).toThrow();
    expect(() => assertReadOnly('SELECT 1; DROP TABLE t')).toThrow();
    expect(quoteTable('dbo.Stg_Sales')).toBe('[dbo].[Stg_Sales]');
  });

  it('writes a live SQL Server source step', () => {
    const steps = sourceSteps({
      name: 'Stg Sales',
      file: 'x.json',
      kind: 'sql',
      rowCount: 0,
      headers: [],
      sql: { server: 'localhost\\SQLEXPRESS', database: 'Shop', auth: 'windows', query: 'SELECT * FROM [dbo].[Stg_Sales]', fetchedAt: '' },
    });
    expect(steps).toEqual([{ name: 'Source', expr: 'Sql.Database("localhost\\SQLEXPRESS", "Shop", [Query="SELECT * FROM [dbo].[Stg_Sales]"])' }]);
  });
});

describe('AI model picking', () => {
  it('chooses a current general-purpose chat model', () => {
    const gemini = [
      'embedding-001',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-flash',
      'gemini-3-flash-preview-09-2026',
      'gemini-3-pro',
      'gemini-3-flash-image',
      'text-embedding-004',
    ];
    expect(pickChatModel(gemini)).toBe('gemini-3-flash');
    expect(pickChatModel(gemini, 'gemini-3-pro')).toBe('gemini-3-pro');
    expect(pickChatModel(['whisper-large-v3', 'llama-3.3-70b-versatile', 'llama-guard-4-12b'])).toBe('llama-3.3-70b-versatile');
  });

  it('ranks a real 2026 Gemini key list sensibly', () => {
    const ids = [
      'antigravity-preview-latest', 'aqa', 'deep-research-preview-04-2026', 'gemini-2.5-flash', 'gemini-2.5-flash-image', 'gemini-2.5-flash-lite',
      'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.5-flash',
      'gemini-3.5-flash-lite', 'gemini-3.5-transcribe', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3.8-live',
      'gemini-4-argon', 'gemini-embedding-001', 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-nano-banana-2.1', 'gemini-omni-1.1-flash',
      'gemini-pro-latest', 'gemma-4-31b-it', 'lyria-3.5', 'veo-3.1-generate-preview',
    ];
    const ranked = rankChatModels(ids);
    expect(ranked.slice(0, 4)).toEqual(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash']);
    // When the chosen model fails: two best full models + two quick lite ones, tried at the same time.
    expect(testCandidates(ids, 'gemini-2.5-flash')).toEqual(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    expect(ranked.some((m) => /antigravity|deep-research|tts|live|lyria|banana|omni|argon|embedding|transcribe|veo|image/.test(m))).toBe(false);
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
