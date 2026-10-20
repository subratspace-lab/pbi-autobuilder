// Types shared by the client and the server. Every stage of the wizard is a
// plain JSON "spec" that the AI (or the rule engine) proposes, the user edits,
// and the server turns into Power Query M / TMDL / PBIR.

export type Cell = string | number | boolean | null;

export type ColumnType = 'text' | 'number' | 'integer' | 'currency' | 'date' | 'datetime' | 'boolean';

export type Culture = 'en-US' | 'en-GB';

// ---------- Upload / ingest ----------

export interface SourceTable {
  /** Query/table name used in Power BI (unique, friendly). */
  name: string;
  file: string;
  kind: 'csv' | 'excel';
  sheet?: string;
  delimiter?: string;
  rowCount: number;
  headers: string[];
}

export interface Brief {
  fileName?: string;
  text: string;
}

// ---------- Profile ----------

export interface ColumnProfile {
  name: string;
  inferredType: ColumnType;
  count: number;
  nulls: number;
  nullPct: number;
  distinct: number;
  topValues: { value: string; count: number }[];
  min?: string | number;
  max?: string | number;
  mean?: number;
  sum?: number;
  samples: string[];
  issues: string[];
  stats: {
    whitespace: number;
    caseVariants: number;
    numericLike: number;
    dateLike: number;
    currencyLike: number;
    currencySymbols?: string[];
  };
}

export interface TableProfile {
  table: string;
  rowCount: number;
  duplicateRows: number;
  blankRows: number;
  culture: Culture;
  columns: ColumnProfile[];
}

// ---------- Business analysis ----------

export interface Kpi {
  name: string;
  definition: string;
  formulaHint: string;
}

export interface Analysis {
  businessSummary: string;
  businessQuestions: string[];
  kpis: Kpi[];
  dataIssues: string[];
  dashboardIdea: string;
  source: 'ai' | 'rules';
}

// ---------- Cleaning ----------

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterOrEqual'
  | 'lessOrEqual'
  | 'contains'
  | 'notContains'
  | 'isNotBlank';

export type DatePart = 'year' | 'month' | 'monthName' | 'quarter' | 'day' | 'weekdayName' | 'age';

export type AddColumnSpec =
  | { kind: 'arithmetic'; left: string; operator: '+' | '-' | '*' | '/'; right: string | number }
  | { kind: 'datePart'; column: string; part: DatePart }
  | { kind: 'concat'; columns: string[]; separator: string }
  | {
      kind: 'conditional';
      column: string;
      operator: FilterOperator;
      value: string | number;
      then: string;
      else: string;
    }
  /** Numeric bands: value <= bounds[i] → labels[i]; above the last bound → last label. Adds a hidden "<name> Sort" column. */
  | { kind: 'bucket'; column: string; bounds: number[]; labels: string[] }
  | { kind: 'custom'; mExpression: string; type: ColumnType };

export type CleaningOp = { id: string; enabled: boolean; title?: string; reason?: string } & (
  | { op: 'setType'; column: string; type: ColumnType }
  | { op: 'trim'; columns: string[] }
  | { op: 'clean'; columns: string[] }
  | { op: 'properCase'; columns: string[] }
  | { op: 'upperCase'; columns: string[] }
  | { op: 'lowerCase'; columns: string[] }
  | { op: 'emptyToNull'; columns: string[] }
  | { op: 'replaceValues'; column: string; find: string | number | null; replace: string | number | null; wholeValue: boolean }
  | { op: 'replaceNulls'; column: string; value: string | number }
  | { op: 'removeDuplicates'; columns?: string[] }
  | { op: 'removeBlankRows' }
  | { op: 'removeRowsWithBlank'; column: string }
  | { op: 'fillDown'; columns: string[] }
  | { op: 'splitColumn'; column: string; delimiter: string; newColumns: string[] }
  | { op: 'addColumn'; name: string; spec: AddColumnSpec }
  | { op: 'rename'; from: string; to: string }
  | { op: 'removeColumns'; columns: string[] }
  | { op: 'filterRows'; column: string; operator: FilterOperator; value?: string | number }
);

export type CleaningOpKind = CleaningOp['op'];

export interface TableCleaning {
  table: string;
  culture: Culture;
  ops: CleaningOp[];
  /** Explicit final types chosen by the user (override inference). */
  finalTypes?: Record<string, ColumnType>;
}

export interface CleanedColumn {
  name: string;
  type: ColumnType;
  /** Power BI "Sort by column" (e.g. a bucket label sorted by its order number). */
  sortBy?: string;
  hidden?: boolean;
}

export interface CleaningResult {
  table: string;
  rowsBefore: number;
  rowsAfter: number;
  columns: CleanedColumn[];
  previewBefore: { headers: string[]; rows: Cell[][] };
  previewAfter: { headers: string[]; rows: Cell[][] };
  stepStats: { id: string; title: string; rowsAfter: number; note?: string }[];
  warnings: string[];
  m: string;
}

// ---------- Model ----------

export interface ModelTable {
  name: string;
  role: 'fact' | 'dimension';
  /** Name of the cleaned (staging) query this table is built from. */
  source: string;
  columns: string[];
  /** For dimensions: unique key column; rows are de-duplicated on it. */
  key?: string;
  hidden?: string[];
}

export interface Relationship {
  fromTable: string; // many side
  fromColumn: string;
  toTable: string; // one side
  toColumn: string;
  active?: boolean;
}

export interface DateTableSpec {
  enabled: boolean;
  name: string;
  table: string;
  column: string;
}

export interface ModelSpec {
  tables: ModelTable[];
  relationships: Relationship[];
  dateTable: DateTableSpec;
  source: 'ai' | 'rules' | 'user';
}

// ---------- Measures ----------

export interface MeasureSpec {
  name: string;
  expression: string;
  formatString: string;
  displayFolder: string;
  description: string;
}

export interface LintIssue {
  measure: string;
  level: 'error' | 'warning';
  message: string;
}

// ---------- Report ----------

export type VisualType =
  | 'card'
  | 'multiRowCard'
  | 'lineChart'
  | 'clusteredBarChart'
  | 'clusteredColumnChart'
  | 'donutChart'
  | 'pivotTable'
  | 'tableEx'
  | 'map'
  | 'slicer';

export interface FieldRef {
  kind: 'measure' | 'column';
  table: string;
  name: string;
}

export interface VisualField {
  role: string;
  field: FieldRef;
}

export interface VisualSpec {
  id: string;
  type: VisualType;
  title: string;
  fields: VisualField[];
  sortDescending?: boolean;
}

export interface ThemeSpec {
  name: string;
  dataColors: string[];
  background: string;
  foreground: string;
  tableAccent: string;
}

export interface ReportSpec {
  title: string;
  subtitle: string;
  visuals: VisualSpec[];
  theme: ThemeSpec;
  source: 'ai' | 'rules' | 'user';
}

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReportLayout {
  width: number;
  height: number;
  boxes: LayoutBox[];
}

// ---------- Project ----------

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tables: SourceTable[];
  brief: Brief;
  profiles: TableProfile[];
  analysis?: Analysis;
  cleaning: TableCleaning[];
  cleanedSchemas: Record<string, CleanedColumn[]>;
  model?: ModelSpec;
  measures: MeasureSpec[];
  report?: ReportSpec;
  /** embedData (default true): data travels inside the model, so refresh works on any PC without files. */
  export: { dataFolder: string; projectFileName: string; embedData?: boolean };
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  tables: number;
}

// ---------- Settings ----------

export interface LlmSettings {
  provider: 'gemini' | 'groq' | 'openrouter' | 'ollama' | 'custom';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
}

export interface ExportCheck {
  table: string;
  rows: number;
}

export interface MeasureCheck {
  name: string;
  value: number | null;
  note?: string;
}

export interface PreviewData {
  measures: Record<string, number | null>;
  visuals: Record<string, { category: string; values: Record<string, number | null> }[]>;
}
