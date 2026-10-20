import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { CleanedColumn, ColumnType, MeasureSpec, ModelSpec, ModelTable, Project } from '../../../shared/types.js';
import { mLet, mString, mStringList, mId, mField } from './m.js';
import { DATE_COLUMNS, MEASURE_TABLE } from './model.js';
import { daxColumn } from './dax.js';
import { isIdLikeName } from './values.js';
import type { PipelineOutput } from './cleaning.js';

// Writes the semantic model as TMDL (Tabular Model Definition Language).

const TAB = '\t';
const uuid = () => crypto.randomUUID();

export function tmdlName(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function indentBlock(text: string, level: number) {
  const pad = TAB.repeat(level);
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.trim() ? pad + l : ''))
    .join('\n');
}

function dataType(t: ColumnType) {
  switch (t) {
    case 'text':
      return 'string';
    case 'integer':
      return 'int64';
    case 'number':
      return 'double';
    case 'currency':
      return 'decimal';
    case 'date':
    case 'datetime':
      return 'dateTime';
    case 'boolean':
      return 'boolean';
  }
}

function formatString(t: ColumnType): string | undefined {
  switch (t) {
    case 'integer':
      return '0';
    case 'number':
      return '#,0.00';
    case 'currency':
      return '#,0.00';
    case 'date':
      return 'yyyy-mm-dd';
    case 'datetime':
      return 'yyyy-mm-dd hh:nn';
  }
}

interface ColumnOptions {
  hidden?: boolean;
  sortBy?: string;
  calculated?: boolean;
  isKey?: boolean;
}

function columnTmdl(col: CleanedColumn, opts: ColumnOptions = {}) {
  const numeric = ['integer', 'number', 'currency'].includes(col.type);
  const summarize = numeric && !isIdLikeName(col.name) && !opts.calculated ? 'sum' : 'none';
  const lines = [`${TAB}column ${tmdlName(col.name)}`, `${TAB}${TAB}dataType: ${dataType(col.type)}`];
  if (opts.isKey) lines.push(`${TAB}${TAB}isKey`);
  if (opts.calculated) lines.push(`${TAB}${TAB}isNameInferred`);
  const fmt = formatString(col.type);
  if (fmt) lines.push(`${TAB}${TAB}formatString: ${fmt}`);
  if (opts.hidden) lines.push(`${TAB}${TAB}isHidden`);
  lines.push(`${TAB}${TAB}lineageTag: ${uuid()}`);
  lines.push(`${TAB}${TAB}summarizeBy: ${summarize}`);
  if (opts.sortBy) lines.push(`${TAB}${TAB}sortByColumn: ${tmdlName(opts.sortBy)}`);
  lines.push(`${TAB}${TAB}sourceColumn: ${opts.calculated ? `[${col.name}]` : col.name}`);
  lines.push('');
  lines.push(`${TAB}${TAB}annotation SummarizationSetBy = Automatic`);
  if (col.type === 'date') {
    lines.push('');
    lines.push(`${TAB}${TAB}annotation UnderlyingDateTimeDataType = Date`);
  }
  return lines.join('\n');
}

function partitionM(name: string, m: string) {
  return [`${TAB}partition ${tmdlName(name)} = m`, `${TAB}${TAB}mode: import`, `${TAB}${TAB}source =`, indentBlock(m, 4)].join('\n');
}

function descriptionLines(text: string, level: number) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${TAB.repeat(level)}/// ${l}`);
}

function measureTmdl(m: MeasureSpec) {
  const expr = m.expression.replace(/^\s*=\s*/, '').trim();
  const lines = descriptionLines(m.description, 1);
  if (expr.includes('\n')) {
    lines.push(`${TAB}measure ${tmdlName(m.name)} =`);
    lines.push(indentBlock(expr, 3));
  } else {
    lines.push(`${TAB}measure ${tmdlName(m.name)} = ${expr}`);
  }
  if (m.formatString) lines.push(`${TAB}${TAB}formatString: ${m.formatString}`);
  if (m.displayFolder) lines.push(`${TAB}${TAB}displayFolder: ${m.displayFolder}`);
  lines.push(`${TAB}${TAB}lineageTag: ${uuid()}`);
  return lines.join('\n');
}

// ---------- M for model tables ----------

export interface TableQueries {
  /** Staging queries (not loaded), keyed by name. */
  expressions: { name: string; m: string }[];
  /** M for each model table. */
  tables: Map<string, string>;
}

export function stagingName(source: string) {
  return `${source} Base`;
}

/** Steps appended after cleaning to shape a model table (column subset, unique keys). */
function shapeSteps(t: ModelTable, cleaned: PipelineOutput, prev: string): { name: string; expr: string }[] {
  const steps: { name: string; expr: string }[] = [];
  const all = cleaned.headers;
  let p = prev;
  const push = (name: string, expr: string) => {
    steps.push({ name, expr });
    p = name;
  };
  if (t.columns.length !== all.length || t.columns.some((c, i) => all[i] !== c)) {
    push('Kept Model Columns', `Table.SelectColumns(${mId(p)}, ${mStringList(t.columns)})`);
  }
  if (t.role === 'dimension' && t.key) {
    const keyType = cleaned.columns.find((c) => c.name === t.key)?.type;
    push('Removed Blank Keys', `Table.SelectRows(${mId(p)}, each ${mField(t.key)} <> null and ${mField(t.key)} <> "")`);
    const criteria = keyType === 'text' ? `{${mString(t.key)}, Comparer.OrdinalIgnoreCase}` : mString(t.key);
    push('Unique Keys', `Table.Distinct(${mId(p)}, ${criteria})`);
  }
  return steps;
}

export interface RawData {
  headers: string[];
  rows: unknown[][];
}

const CHUNK = 60_000;

/**
 * Source steps that carry the raw data inside the query (like Power BI's
 * "Enter data"): JSON rows, deflate-compressed, base64. No file path needed.
 * The last step keeps the name "Promoted Headers" so all cleaning steps still apply.
 */
export function embeddedSourceSteps(raw: RawData): { name: string; expr: string }[] {
  const b64 = zlib.deflateRawSync(Buffer.from(JSON.stringify(raw.rows), 'utf8'), { level: 9 }).toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(`"${b64.slice(i, i + CHUNK)}"`);
  return [
    {
      name: 'Source',
      expr: `Binary.Decompress(Binary.FromText(Text.Combine({${chunks.join(',\n        ')}}), BinaryEncoding.Base64), Compression.Deflate)`,
    },
    { name: 'Promoted Headers', expr: `Table.FromRows(Json.Document(#"Source", 65001), ${mStringList(raw.headers)})` },
  ];
}

/** Replace the file-reading steps (everything up to "Promoted Headers") with other source steps. */
function withSource(steps: { name: string; expr: string }[], source?: { name: string; expr: string }[]) {
  if (!source) return steps;
  const k = steps.findIndex((s) => s.name === 'Promoted Headers');
  if (k < 0) throw new Error('Cleaning steps have no "Promoted Headers" step');
  return [...source, ...steps.slice(k + 1)];
}

export function buildTableQueries(
  model: ModelSpec,
  pipelines: Map<string, PipelineOutput>,
  embedded?: Map<string, { name: string; expr: string }[]>,
): TableQueries {
  const expressions: TableQueries['expressions'] = [];
  const tables = new Map<string, string>();
  const consumers = new Map<string, number>();
  for (const t of model.tables) consumers.set(t.source, (consumers.get(t.source) ?? 0) + 1);

  for (const source of new Set(model.tables.map((t) => t.source))) {
    if ((consumers.get(source) ?? 0) > 1) {
      expressions.push({ name: stagingName(source), m: mLet(withSource(pipelines.get(source)!.steps, embedded?.get(source))) });
    }
  }

  for (const t of model.tables) {
    const cleaned = pipelines.get(t.source)!;
    if ((consumers.get(t.source) ?? 0) > 1) {
      const shape = shapeSteps(t, cleaned, 'Source');
      const steps = [{ name: 'Source', expr: mId(stagingName(t.source)) }, ...shape];
      tables.set(t.name, mLet(steps));
    } else {
      const steps = withSource(cleaned.steps, embedded?.get(t.source));
      const shape = shapeSteps(t, cleaned, steps[steps.length - 1].name);
      tables.set(t.name, mLet([...steps, ...shape]));
    }
  }
  return { expressions, tables };
}

// ---------- files ----------

export function dateTableDax(model: ModelSpec) {
  const col = daxColumn(model.dateTable.table, model.dateTable.column);
  return [
    'VAR MinDate = MIN(' + col + ')',
    'VAR MaxDate = MAX(' + col + ')',
    'VAR StartDate = IF(ISBLANK(MinDate), DATE(YEAR(TODAY()), 1, 1), DATE(YEAR(MinDate), 1, 1))',
    'VAR EndDate = IF(ISBLANK(MaxDate), DATE(YEAR(TODAY()), 12, 31), DATE(YEAR(MaxDate), 12, 31))',
    'RETURN',
    '    ADDCOLUMNS(',
    '        CALENDAR(StartDate, EndDate),',
    '        "Year", YEAR([Date]),',
    '        "Quarter", "Q" & QUARTER([Date]),',
    '        "Month Number", MONTH([Date]),',
    '        "Month", FORMAT([Date], "MMM"),',
    '        "Year Month", FORMAT([Date], "YYYY-MM"),',
    '        "Day of Week", FORMAT([Date], "ddd"),',
    '        "Day of Week Number", WEEKDAY([Date], 2)',
    '    )',
  ].join('\n');
}

export interface TmdlFiles {
  [relativePath: string]: string;
}

export function buildTmdl(
  project: Project,
  model: ModelSpec,
  measures: MeasureSpec[],
  pipelines: Map<string, PipelineOutput>,
  dataFolder: string,
  embedded?: Map<string, { name: string; expr: string }[]>,
): TmdlFiles {
  const files: TmdlFiles = {};
  const queries = buildTableQueries(model, pipelines, embedded);
  const fkColumns = new Set(model.relationships.map((r) => `${r.fromTable}|${r.fromColumn}`));

  files['database.tmdl'] = `database\n${TAB}compatibilityLevel: 1567\n`;

  const folder = dataFolder.endsWith('\\') || dataFolder.endsWith('/') ? dataFolder : `${dataFolder}\\`;
  const expr: string[] = [
    `expression DataFolder = ${mString(folder)} meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]`,
    `${TAB}lineageTag: ${uuid()}`,
    '',
    `${TAB}annotation PBI_ResultType = Text`,
  ];
  for (const e of queries.expressions) {
    expr.push('', `expression ${tmdlName(e.name)} =`, indentBlock(e.m, 2), `${TAB}lineageTag: ${uuid()}`, '', `${TAB}annotation PBI_ResultType = Table`);
  }
  files['expressions.tmdl'] = expr.join('\n') + '\n';

  const tableOrder: string[] = [];
  for (const t of model.tables) {
    const cols = t.columns.map(
      (c) => project.cleanedSchemas[t.source]?.find((s) => s.name === c) ?? { name: c, type: 'text' as ColumnType },
    );
    const parts = [`table ${tmdlName(t.name)}`, `${TAB}lineageTag: ${uuid()}`, ''];
    for (const c of cols) {
      const hidden =
        (t.role === 'fact' && fkColumns.has(`${t.name}|${c.name}`) && isIdLikeName(c.name)) || t.hidden?.includes(c.name) || Boolean(c.hidden);
      const sortBy = c.sortBy && t.columns.includes(c.sortBy) ? c.sortBy : undefined;
      parts.push(columnTmdl(c, { hidden, sortBy }), '');
    }
    parts.push(partitionM(t.name, queries.tables.get(t.name)!), '');
    parts.push(`${TAB}annotation PBI_ResultType = Table`);
    files[`tables/${t.name}.tmdl`] = parts.join('\n') + '\n';
    tableOrder.push(t.name);
  }

  if (model.dateTable.enabled) {
    const dt = model.dateTable.name;
    const parts = [`table ${tmdlName(dt)}`, `${TAB}lineageTag: ${uuid()}`, `${TAB}dataCategory: Time`, ''];
    for (const c of DATE_COLUMNS) {
      const sortBy = c.name === 'Month' ? 'Month Number' : c.name === 'Day of Week' ? 'Day of Week Number' : undefined;
      parts.push(columnTmdl(c, { calculated: true, isKey: c.name === 'Date', sortBy }), '');
    }
    parts.push(`${TAB}partition ${tmdlName(dt)} = calculated`, `${TAB}${TAB}mode: import`, `${TAB}${TAB}source =`, indentBlock(dateTableDax(model), 4), '');
    files[`tables/${dt}.tmdl`] = parts.join('\n') + '\n';
    tableOrder.push(dt);
  }

  // Measure table: one hidden placeholder column so Power BI shows the measure-table icon.
  const mt = [`table ${MEASURE_TABLE}`, `${TAB}lineageTag: ${uuid()}`, ''];
  for (const m of measures) mt.push(measureTmdl(m), '');
  mt.push(
    `${TAB}column Placeholder`,
    `${TAB}${TAB}dataType: string`,
    `${TAB}${TAB}isHidden`,
    `${TAB}${TAB}lineageTag: ${uuid()}`,
    `${TAB}${TAB}summarizeBy: none`,
    `${TAB}${TAB}sourceColumn: Placeholder`,
    '',
    partitionM(MEASURE_TABLE, 'let\n    Source = #table(type table [Placeholder = text], {})\nin\n    Source'),
    '',
    `${TAB}annotation PBI_ResultType = Table`,
  );
  files[`tables/${MEASURE_TABLE}.tmdl`] = mt.join('\n') + '\n';
  tableOrder.unshift(MEASURE_TABLE);

  const rels: string[] = [];
  for (const r of model.relationships) {
    rels.push(`relationship ${uuid()}`);
    if (r.active === false) rels.push(`${TAB}isActive: false`);
    rels.push(`${TAB}fromColumn: ${tmdlName(r.fromTable)}.${tmdlName(r.fromColumn)}`);
    rels.push(`${TAB}toColumn: ${tmdlName(r.toTable)}.${tmdlName(r.toColumn)}`);
    rels.push('');
  }
  if (rels.length) files['relationships.tmdl'] = rels.join('\n');

  const queryOrder = ['DataFolder', ...queries.expressions.map((e) => e.name), ...model.tables.map((t) => t.name), MEASURE_TABLE];
  files['model.tmdl'] = [
    'model Model',
    `${TAB}culture: en-US`,
    `${TAB}defaultPowerBIDataSourceVersion: powerBI_V3`,
    `${TAB}sourceQueryCulture: en-US`,
    `${TAB}dataAccessOptions`,
    `${TAB}${TAB}legacyRedirects`,
    `${TAB}${TAB}returnErrorValuesAsNull`,
    '',
    `annotation PBI_QueryOrder = ${JSON.stringify(queryOrder)}`,
    '',
    'annotation __PBI_TimeIntelligenceEnabled = 0',
    '',
    ...tableOrder.map((t) => `ref table ${tmdlName(t)}`),
    '',
  ].join('\n');

  return files;
}
