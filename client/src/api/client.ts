import type {
  Analysis,
  Cell,
  CleaningResult,
  LintIssue,
  LlmSettings,
  MeasureCheck,
  MeasureSpec,
  ModelSpec,
  PreviewData,
  Project,
  ProjectSummary,
  PagePreview,
  ReportSpec,
  ScriptConnection,
  TableCleaning,
  ExportCheck,
} from '@shared/types';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

const enc = encodeURIComponent;
export type Mode = 'ai' | 'rules';

export interface ExportResult {
  folder: string;
  zipPath: string;
  projectFile: string;
  dataFolder: string;
  rowChecks: ExportCheck[];
  measureChecks: MeasureCheck[];
  warnings: string[];
}

/** SQL Server connection form; the password is sent only for this request and never stored. */
export interface SqlForm {
  server: string;
  database: string;
  auth: 'windows' | 'sql';
  user?: string;
  password?: string;
  /** Script whose written password may be used when none is typed. */
  scriptFile?: string;
}

export interface ExportStatus {
  exists: boolean;
  name: string;
  folder: string;
  projectFile: string;
  zipPath: string;
  zipExists: boolean;
  powerBiDesktop: string | null;
}

export const api = {
  settings: () => request<{ settings: LlmSettings; presets: Record<string, { baseUrl: string; model: string }> }>('GET', '/settings'),
  saveSettings: (s: { provider: string; baseUrl: string; model: string; apiKey: string }) =>
    request<{ settings: LlmSettings }>('PUT', '/settings', s),
  testSettings: (s: { provider: string; baseUrl: string; model: string; apiKey: string }) =>
    request<{ ok: boolean; reply?: string; error?: string; note?: string; settings?: LlmSettings; models?: string[] }>('POST', '/settings/test', s),
  listModels: (s: { provider: string; baseUrl: string; model: string; apiKey: string }) =>
    request<{ ok: boolean; models?: string[]; suggested?: string; error?: string }>('POST', '/settings/models', s),

  projects: () => request<ProjectSummary[]>('GET', '/projects'),
  createProject: (name: string) => request<Project>('POST', '/projects', { name }),
  project: (id: string) => request<Project>('GET', `/projects/${id}`),
  deleteProject: (id: string) => request('DELETE', `/projects/${id}`),
  patchProject: (id: string, body: Partial<Pick<Project, 'name' | 'brief' | 'export'>>) => request<Project>('PATCH', `/projects/${id}`, body),

  upload: (id: string, files: File[], kind: 'data' | 'brief' | 'script' = 'data') => {
    const form = new FormData();
    form.append('kind', kind);
    for (const f of files) form.append('files', f, f.name);
    return request<{ project: Project; warnings: string[] }>('POST', `/projects/${id}/files`, form);
  },
  deleteTable: (id: string, table: string) => request<Project>('DELETE', `/projects/${id}/tables/${enc(table)}`),
  scriptConnection: (id: string, file: string) =>
    request<{ connection: ScriptConnection; candidates: Record<string, string[]> }>('GET', `/projects/${id}/scripts/${enc(file)}/connection`),
  sqlTest: (id: string, c: SqlForm) => request<{ ok: boolean; server: string; database: string; version: string }>('POST', `/projects/${id}/sql/test`, c),
  sqlTables: (id: string, c: SqlForm) => request<{ tables: { name: string; view: boolean }[] }>('POST', `/projects/${id}/sql/tables`, c),
  sqlImport: (id: string, c: SqlForm & { items: { table?: string; query?: string; name?: string }[] }) =>
    request<{ project: Project; loaded: string[]; warnings: string[] }>('POST', `/projects/${id}/sql/import`, c),
  importPath: (id: string, filePath: string) => request<{ project: Project; loaded: string[]; warnings: string[] }>('POST', `/projects/${id}/files/from-path`, { path: filePath }),
  refreshTable: (id: string, table: string, password?: string) =>
    request<{ project: Project; loaded: string[]; warnings: string[] }>('POST', `/projects/${id}/tables/${enc(table)}/refresh`, { password }),
  setScriptTable: (id: string, file: string, table: string) => request<Project>('PATCH', `/projects/${id}/scripts/${enc(file)}`, { table }),
  deleteScript: (id: string, file: string) => request<Project>('DELETE', `/projects/${id}/scripts/${enc(file)}`),
  applyScript: (id: string, file: string, table?: string) =>
    request<{ project: Project; table: string; steps: number; notes: string[] }>('POST', `/projects/${id}/scripts/${enc(file)}/apply`, { table }),
  raw: (id: string, table: string) => request<{ headers: string[]; rows: Cell[][]; total: number }>('GET', `/projects/${id}/tables/${enc(table)}/raw`),

  profile: (id: string) => request<Project>('POST', `/projects/${id}/profile`),
  analyze: (id: string, mode: Mode) => request<Project>('POST', `/projects/${id}/analyze`, { mode }),
  saveAnalysis: (id: string, a: Analysis) => request<Project>('PUT', `/projects/${id}/analysis`, a),

  suggestCleaning: (id: string, mode: Mode, table?: string) =>
    request<{ project: Project; warnings: string[] }>('POST', `/projects/${id}/cleaning/suggest`, { mode, table }),
  cleaning: (id: string, table: string) => request<{ cleaning: TableCleaning; result: CleaningResult }>('GET', `/projects/${id}/cleaning/${enc(table)}`),
  saveCleaning: (id: string, table: string, c: TableCleaning) =>
    request<{ cleaning: TableCleaning; result: CleaningResult; project: Project }>('PUT', `/projects/${id}/cleaning/${enc(table)}`, c),

  suggestModel: (id: string, mode: Mode) => request<{ project: Project; issues: string[] }>('POST', `/projects/${id}/model/suggest`, { mode }),
  saveModel: (id: string, m: ModelSpec) => request<{ project: Project; issues: string[] }>('PUT', `/projects/${id}/model`, m),

  suggestMeasures: (id: string, mode: Mode) => request<{ project: Project; lint: LintIssue[] }>('POST', `/projects/${id}/measures/suggest`, { mode }),
  saveMeasures: (id: string, m: MeasureSpec[]) => request<{ project: Project; lint: LintIssue[] }>('PUT', `/projects/${id}/measures`, m),
  checkMeasures: (id: string) => request<{ lint: LintIssue[]; values: MeasureCheck[] }>('GET', `/projects/${id}/measures/check`),

  suggestReport: (id: string, mode: Mode) => request<{ project: Project; issues: string[] }>('POST', `/projects/${id}/report/suggest`, { mode }),
  saveReport: (id: string, r: ReportSpec) => request<{ project: Project; issues: string[] }>('PUT', `/projects/${id}/report`, r),
  reportPreview: (id: string) => request<{ pages: PagePreview[]; data: PreviewData }>('GET', `/projects/${id}/report/preview`),

  export: (id: string) => request<ExportResult>('POST', `/projects/${id}/export`),
  openExport: (id: string, target: 'folder' | 'pbip') =>
    request<{ ok: boolean; target: string; method?: 'powerbi' | 'default-app' }>('POST', `/projects/${id}/export/open`, { target }),
  exportStatus: (id: string) => request<ExportStatus>('GET', `/projects/${id}/export/status`),
  downloadUrl: (id: string) => `/api/projects/${id}/export/download`,
};
