import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Analysis, CleaningOp, MeasureSpec, ModelSpec, Project, ReportSpec, SqlConnection, TableCleaning, TransformScript } from '../../../shared/types.js';
import {
  briefDir,
  createProject,
  dataDir,
  deleteProject,
  getCleaning,
  getPipeline,
  getProject,
  getRaw,
  listProjects,
  refreshCleanedSchemas,
  saveProject,
} from '../services/store.js';
import { describeDataFile, isBriefFile, isDataFile, readBriefFile } from '../services/ingest.js';
import { detectScriptTable, scriptColumns, scriptLanguage, scriptText, translateScript } from '../services/scripts.js';
import { detectConnection, runQuery, scriptPassword } from '../services/sqlserver.js';
import { autoLoadFromScript, findCandidates, importLocalFile, importSqlQuery } from '../services/sources.js';
import { profileTable } from '../services/profile.js';
import { analysisRules, cleaningRules, measureRules, modelRules, newId, reportRules } from '../services/rules.js';
import { aiAnalyze, aiCleaning, aiMeasures, aiModel, aiReport } from '../services/ai.js';
import { MEASURE_TABLE, modelColumns, validateModel } from '../services/model.js';
import { lintMeasures } from '../services/dax.js';
import { measureChecks, reportPreview } from '../services/preview.js';
import { layoutPage, normalizeVisual, reportPages } from '../services/report.js';
import { exportLocation, exportProject } from '../services/pbipWriter.js';
import { findPowerBiDesktop, openFolder, openInPowerBi } from '../services/opener.js';
import { APP_ROOT } from '../services/paths.js';
import {
  MASTER,
  collectionsAnalysis,
  collectionsCleaning,
  collectionsMeasures,
  collectionsModel,
  collectionsReady,
  collectionsReport,
  detectCollections,
} from '../services/packs/collections.js';

export const projects = Router();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(out);
  }, next);
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

function load(req: Request) {
  return getProject(req.params.id);
}

function useAi(req: Request) {
  return (req.body?.mode ?? 'ai') === 'ai';
}

function requireProfiles(p: Project) {
  if (!p.tables.length) throw fail(400, 'Upload at least one data file first');
  if (p.profiles.length !== p.tables.length) {
    p.profiles = p.tables.map((t) => profileTable(t.name, getRaw(p.id, t)));
  }
}

/**
 * After the data changes, everything built on the old data is stale: drop it
 * so no step silently keeps pointing at tables that no longer exist.
 * Cleaning steps of tables that still exist are kept. Returns true if anything was reset.
 */
function resetDownstream(p: Project): boolean {
  const names = new Set(p.tables.map((t) => t.name));
  const hadWork = Boolean(p.analysis || p.model || p.measures.length || p.report);
  p.profiles = [];
  p.cleaning = p.cleaning.filter((c) => names.has(c.table));
  p.cleanedSchemas = {};
  p.analysis = undefined;
  p.model = undefined;
  p.measures = [];
  p.report = undefined;
  return hadWork;
}

function requireModel(p: Project): ModelSpec {
  if (!p.model) throw fail(400, 'Build the data model first');
  const missing = p.model.tables.filter((t) => !p.tables.some((x) => x.name === t.source));
  if (missing.length) throw fail(400, `The model uses tables that no longer exist (${missing.map((t) => t.source).join(', ')}) — redesign the model`);
  refreshCleanedSchemas(p);
  return validateModel(p, p.model).model;
}

// ---------- projects ----------

projects.get('/', h(() => listProjects()));
projects.post('/', h((req) => createProject(String(req.body?.name ?? ''))));
projects.get('/:id', h((req) => load(req)));
projects.delete('/:id', h((req) => {
  deleteProject(req.params.id);
  return { ok: true };
}));
projects.patch('/:id', h((req) => {
  const p = load(req);
  const { name, brief, export: exp } = req.body ?? {};
  if (typeof name === 'string' && name.trim()) p.name = name.trim();
  if (brief && typeof brief.text === 'string') p.brief = { ...p.brief, text: brief.text };
  if (exp) p.export = { ...p.export, ...exp, embedData: exp.embedData !== false };
  return saveProject(p);
}));

// ---------- upload ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(dataDir(req.params.id), '..', 'incoming');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_'));
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

projects.post(
  '/:id/files',
  upload.array('files', 20),
  h(async (req) => {
    const p = load(req);
    const files = (req.files as Express.Multer.File[]) ?? [];
    const warnings: string[] = [];
    const briefTexts: string[] = [];
    const asBrief = req.body?.kind === 'brief';
    const newScripts: TransformScript[] = [];
    let dataLoaded = false;
    for (const f of files) {
      const name = f.filename;
      if (!asBrief && isDataFile(name)) {
        const target = path.join(dataDir(p.id), name);
        fs.renameSync(f.path, target);
        // Re-uploading a file replaces its tables.
        const kept = p.tables.filter((t) => t.file !== name);
        try {
          const added = describeDataFile(target, kept);
          if (!added.length) warnings.push(`${name}: no data found`);
          p.tables = [...kept, ...added];
        } catch (e) {
          warnings.push(`${name}: could not be read (${(e as Error).message})`);
          fs.rmSync(target, { force: true });
        }
      } else if (scriptLanguage(name)) {
        // SQL / Python transformation script: kept as a reference and translated into cleaning steps.
        const raw = fs.readFileSync(f.path, 'utf8');
        fs.rmSync(f.path, { force: true });
        const script: TransformScript = { fileName: name, language: scriptLanguage(name)!, text: scriptText(name, raw) };
        p.scripts = [...(p.scripts ?? []).filter((x) => x.fileName !== name), script];
        newScripts.push(script);
        // If the script says where its data is (SQL Server details or a full file path), load it now.
        const auto = await autoLoadFromScript(p, script);
        if (auto.loaded.length) {
          dataLoaded = true;
          warnings.push(`${name}: loaded ${auto.loaded.join('; ')}`);
        }
        warnings.push(...auto.notes);
      } else if (isBriefFile(name)) {
        const target = path.join(briefDir(p.id), name);
        fs.mkdirSync(briefDir(p.id), { recursive: true });
        fs.renameSync(f.path, target);
        try {
          briefTexts.push(await readBriefFile(target));
          p.brief.fileName = name;
        } catch (e) {
          warnings.push(`${name}: could not read the brief (${(e as Error).message})`);
        }
      } else {
        fs.rmSync(f.path, { force: true });
        warnings.push(`${name}: unsupported file type`);
      }
    }
    if (briefTexts.length) p.brief.text = [p.brief.text.trim(), ...briefTexts.map((t) => t.trim())].filter(Boolean).join('\n\n');
    for (const script of p.scripts ?? []) {
      if (!script.table || !p.tables.some((t) => t.name === script.table)) script.table = detectScriptTable(script, p);
    }
    for (const script of newScripts.filter((s) => !s.table)) {
      const expected = scriptColumns(script.text);
      const cols = expected.length ? ` (it uses columns like ${expected.slice(0, 6).join(', ')})` : '';
      warnings.push(
        p.tables.length
          ? `${script.fileName} saved — but none of the tables (${p.tables.map((t) => t.name).join(', ')}) has the columns this script uses${cols}. Load the matching data, or choose the table next to the script below.`
          : `${script.fileName} saved. This project has no data yet — load the data the script cleans${cols}: upload the file, enter its path, or connect to SQL Server below.`,
      );
    }
    const dataChanged = dataLoaded || (!asBrief && files.some((f) => isDataFile(f.filename)));
    if (dataChanged && resetDownstream(p)) warnings.push('The data changed, so the analysis, model, measures and dashboard were reset — run those steps again.');
    return { project: saveProject(p), warnings };
  }),
);

projects.post('/:id/sample', h(async (req) => {
  const p = load(req);
  const csv = path.join(APP_ROOT, 'samples', 'superstore_messy.csv');
  const brief = path.join(APP_ROOT, 'samples', 'project_brief.md');
  if (!fs.existsSync(csv)) throw fail(404, 'Sample data missing — run: node scripts/make-sample.mjs');
  fs.copyFileSync(csv, path.join(dataDir(p.id), 'superstore_messy.csv'));
  p.tables = describeDataFile(path.join(dataDir(p.id), 'superstore_messy.csv'), []);
  resetDownstream(p);
  if (fs.existsSync(brief)) {
    p.brief = { fileName: 'project_brief.md', text: fs.readFileSync(brief, 'utf8') };
  }
  return saveProject(p);
}));

projects.delete('/:id/tables/:table', h((req) => {
  const p = load(req);
  const table = p.tables.find((t) => t.name === req.params.table);
  if (!table) throw fail(404, 'Table not found');
  p.tables = p.tables.filter((t) => t !== table);
  if (!p.tables.some((t) => t.file === table.file)) fs.rmSync(path.join(dataDir(p.id), table.file), { force: true });
  resetDownstream(p);
  return saveProject(p);
}));

projects.get('/:id/tables/:table/raw', h((req) => {
  const p = load(req);
  const table = p.tables.find((t) => t.name === req.params.table);
  if (!table) throw fail(404, 'Table not found');
  const raw = getRaw(p.id, table);
  return { headers: raw.headers, rows: raw.rows.slice(0, 200), total: raw.rows.length };
}));

// ---------- profile & analysis ----------

projects.post('/:id/profile', h((req) => {
  const p = load(req);
  if (!p.tables.length) throw fail(400, 'Upload at least one data file first');
  p.profiles = p.tables.map((t) => profileTable(t.name, getRaw(p.id, t)));
  return saveProject(p);
}));

projects.post('/:id/analyze', h(async (req) => {
  const p = load(req);
  requireProfiles(p);
  const plan = detectCollections(p);
  p.analysis = useAi(req) ? await aiAnalyze(p) : plan ? collectionsAnalysis(p, plan) : analysisRules(p);
  return saveProject(p);
}));

projects.put('/:id/analysis', h((req) => {
  const p = load(req);
  p.analysis = req.body as Analysis;
  return saveProject(p);
}));

// ---------- cleaning ----------

function cleaningView(p: Project, table: string) {
  const { headers: _h, rows: _r, steps: _s, ...result } = getPipeline(p, table);
  return { cleaning: getCleaning(p, table), result };
}

projects.post('/:id/cleaning/suggest', h(async (req) => {
  const p = load(req);
  requireProfiles(p);
  const only: string | undefined = req.body?.table;
  let warnings: string[] = [];
  let suggested: Record<string, CleaningOp[]>;
  if (useAi(req)) {
    const res = await aiCleaning(p);
    suggested = res.ops;
    warnings = res.warnings;
  } else {
    // A recognised domain pack (collections) adds its analysis steps on top of the generic fixes.
    const plan = detectCollections(p);
    suggested = Object.fromEntries(p.profiles.map((pr) => [pr.table, cleaningRules(pr, { bands: !plan })]));
    if (plan) {
      for (const [table, ops] of Object.entries(collectionsCleaning(p, plan))) suggested[table] = [...(suggested[table] ?? []), ...ops];
    }
    // An uploaded SQL / Python script is the spec for its table: use its steps.
    for (const script of p.scripts ?? []) {
      const table = script.table ?? detectScriptTable(script, p);
      const t = table && p.tables.find((x) => x.name === table);
      if (!t) continue;
      const res = translateScript(script, t.headers);
      suggested[t.name] = res.ops;
      warnings.push(...res.notes.map((n) => `${script.fileName}: ${n}`));
    }
  }
  for (const t of p.tables) {
    if (only && t.name !== only) continue;
    const ops = suggested[t.name];
    if (!ops) continue;
    const existing = getCleaning(p, t.name);
    p.cleaning = [...p.cleaning.filter((c) => c.table !== t.name), { ...existing, ops }];
  }
  refreshCleanedSchemas(p);
  for (const t of p.tables) warnings.push(...getPipeline(p, t.name).warnings.map((w) => `${t.name}: ${w}`));
  return { project: saveProject(p), warnings };
}));

// ---------- data from SQL Server / local paths ----------

function connFromBody(body: Record<string, unknown>): SqlConnection {
  const server = String(body?.server ?? '').trim();
  const database = String(body?.database ?? '').trim();
  const auth = body?.auth === 'sql' ? 'sql' : 'windows';
  if (!server) throw fail(400, 'Enter the server name (e.g. localhost\\SQLEXPRESS)');
  if (!database) throw fail(400, 'Enter the database name');
  return { server, database, auth, user: auth === 'sql' ? String(body?.user ?? '').trim() : undefined };
}

/** Password typed in the form, else the one written in the script (never stored). */
function passwordFor(p: Project, body: Record<string, unknown>) {
  const typed = typeof body?.password === 'string' && body.password ? body.password : undefined;
  const script = p.scripts?.find((s) => s.fileName === body?.scriptFile);
  return typed ?? (script ? scriptPassword(script) : undefined);
}

const sqlError = (e: unknown) => fail(400, (e as Error).message);

/** After new data arrives: reset later steps and link scripts to their tables. */
function afterDataChange(p: Project, warnings: string[]) {
  if (resetDownstream(p)) warnings.push('The data changed, so the analysis, model, measures and dashboard were reset — run those steps again.');
  for (const s of p.scripts ?? []) if (!s.table || !p.tables.some((t) => t.name === s.table)) s.table = detectScriptTable(s, p);
}

projects.get('/:id/scripts/:file/connection', h((req) => {
  const p = load(req);
  const script = p.scripts?.find((x) => x.fileName === req.params.file);
  if (!script) throw fail(404, 'Script not found');
  const connection = detectConnection(script);
  const candidates = Object.fromEntries(connection.files.filter((f) => !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(f)).map((f) => [f, findCandidates(f)]));
  return { connection, candidates };
}));

projects.post('/:id/sql/test', h(async (req) => {
  const p = load(req);
  const conn = connFromBody(req.body);
  try {
    const r = await runQuery(conn, 'SELECT @@SERVERNAME AS ServerName, DB_NAME() AS DatabaseName, @@VERSION AS Version', passwordFor(p, req.body), 1);
    const row = r.rows[0] ?? [];
    return { ok: true, server: row[0], database: row[1], version: String(row[2] ?? '').split('\n')[0] };
  } catch (e) {
    throw sqlError(e);
  }
}));

projects.post('/:id/sql/tables', h(async (req) => {
  const p = load(req);
  const conn = connFromBody(req.body);
  try {
    const r = await runQuery(
      conn,
      "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME",
      passwordFor(p, req.body),
      5000,
    );
    return { tables: r.rows.map((row) => ({ name: String(row[0]), view: String(row[1]).includes('VIEW') })) };
  } catch (e) {
    throw sqlError(e);
  }
}));

projects.post('/:id/sql/import', h(async (req) => {
  const p = load(req);
  const conn = connFromBody(req.body);
  const items = (Array.isArray(req.body?.items) ? req.body.items : []) as { table?: string; query?: string; name?: string }[];
  if (!items.length) throw fail(400, 'Choose at least one table or enter a query');
  const password = passwordFor(p, req.body);
  const warnings: string[] = [];
  const loaded: string[] = [];
  for (const item of items) {
    try {
      const r = await importSqlQuery(p, conn, password, item);
      loaded.push(`${r.name} (${r.rows.toLocaleString()} rows)`);
      if (r.truncated) warnings.push(`${r.name}: only the first 1,000,000 rows were loaded for the preview — Power BI loads everything on refresh`);
    } catch (e) {
      warnings.push(`${item.table ?? 'Query'}: ${(e as Error).message}`);
    }
  }
  if (!loaded.length) throw fail(400, warnings.join(' · ') || 'Nothing was loaded');
  afterDataChange(p, warnings);
  return { project: saveProject(p), loaded, warnings };
}));

projects.post('/:id/files/from-path', h((req) => {
  const p = load(req);
  const filePath = String(req.body?.path ?? '').trim();
  if (!filePath) throw fail(400, 'Enter the full path of the file, e.g. C:\\Data\\sales.csv');
  let loaded: string[];
  try {
    loaded = importLocalFile(p, filePath);
  } catch (e) {
    throw fail(400, (e as Error).message);
  }
  const warnings: string[] = [];
  afterDataChange(p, warnings);
  return { project: saveProject(p), loaded, warnings };
}));

/** Reload a SQL Server table (Windows sign-in, or the password typed now / written in a script). */
projects.post('/:id/tables/:table/refresh', h(async (req) => {
  const p = load(req);
  const table = p.tables.find((t) => t.name === req.params.table);
  if (!table?.sql) throw fail(400, 'Only SQL Server tables can be refreshed — re-upload files instead');
  const { query, ...conn } = table.sql;
  const password = passwordFor(p, req.body) ?? p.scripts?.map((s) => scriptPassword(s)).find(Boolean);
  try {
    const r = await importSqlQuery(p, conn, password, { query, name: table.name });
    const warnings: string[] = [];
    afterDataChange(p, warnings);
    return { project: saveProject(p), loaded: [`${r.name} (${r.rows.toLocaleString()} rows)`], warnings };
  } catch (e) {
    throw sqlError(e);
  }
}));

// ---------- transformation scripts ----------

projects.patch('/:id/scripts/:file', h((req) => {
  const p = load(req);
  const script = p.scripts?.find((x) => x.fileName === req.params.file);
  if (!script) throw fail(404, 'Script not found');
  const table = String(req.body?.table ?? '');
  if (table && !p.tables.some((t) => t.name === table)) throw fail(400, 'Unknown table');
  script.table = table || undefined;
  return saveProject(p);
}));

projects.delete('/:id/scripts/:file', h((req) => {
  const p = load(req);
  p.scripts = (p.scripts ?? []).filter((x) => x.fileName !== req.params.file);
  return saveProject(p);
}));

/** Translate one script into cleaning steps for its table (replaces that table's steps). */
projects.post('/:id/scripts/:file/apply', h((req) => {
  const p = load(req);
  const script = p.scripts?.find((x) => x.fileName === req.params.file);
  if (!script) throw fail(404, 'Script not found');
  const tableName = String(req.body?.table ?? script.table ?? detectScriptTable(script, p) ?? '');
  const table = p.tables.find((t) => t.name === tableName);
  if (!table) throw fail(400, 'Choose which table this script applies to');
  script.table = table.name;
  const res = translateScript(script, table.headers);
  const existing = getCleaning(p, table.name);
  p.cleaning = [...p.cleaning.filter((c) => c.table !== table.name), { ...existing, ops: res.ops }];
  refreshCleanedSchemas(p);
  const warnings = getPipeline(p, table.name).warnings;
  return { project: saveProject(p), table: table.name, steps: res.ops.length, notes: [...res.notes, ...warnings] };
}));

projects.get('/:id/cleaning/:table', h((req) => cleaningView(load(req), req.params.table)));

projects.put('/:id/cleaning/:table', h((req) => {
  const p = load(req);
  const body = req.body as TableCleaning;
  if (!p.tables.some((t) => t.name === req.params.table)) throw fail(404, 'Table not found');
  const cleaning: TableCleaning = {
    table: req.params.table,
    culture: body.culture === 'en-GB' ? 'en-GB' : 'en-US',
    ops: (body.ops ?? []).map((o) => ({ ...o, id: o.id || newId(), enabled: o.enabled !== false })),
    finalTypes: body.finalTypes,
  };
  p.cleaning = [...p.cleaning.filter((c) => c.table !== cleaning.table), cleaning];
  refreshCleanedSchemas(p);
  saveProject(p);
  return { ...cleaningView(p, cleaning.table), project: p };
}));

// ---------- model ----------

projects.post('/:id/model/suggest', h(async (req) => {
  const p = load(req);
  requireProfiles(p);
  refreshCleanedSchemas(p);
  let issues: string[];
  if (useAi(req)) {
    const res = await aiModel(p);
    p.model = res.model;
    issues = res.issues;
  } else {
    const pipes = new Map(p.tables.map((t) => [t.name, getPipeline(p, t.name)]));
    const plan = collectionsReady(p);
    const res = validateModel(p, plan ? collectionsModel(p, plan) : modelRules(p, pipes));
    p.model = res.model;
    issues = res.issues;
  }
  return { project: saveProject(p), issues };
}));

projects.put('/:id/model', h((req) => {
  const p = load(req);
  refreshCleanedSchemas(p);
  const res = validateModel(p, { ...(req.body as ModelSpec), source: 'user' });
  p.model = res.model;
  return { project: saveProject(p), issues: res.issues };
}));

// ---------- measures ----------

function lint(p: Project, model: ModelSpec) {
  return lintMeasures(p.measures, modelColumns(p, model), MEASURE_TABLE);
}

projects.post('/:id/measures/suggest', h(async (req) => {
  const p = load(req);
  const model = requireModel(p);
  const plan = collectionsReady(p);
  p.measures = useAi(req) ? await aiMeasures(p, model) : plan && model.tables.some((t) => t.name === MASTER) ? collectionsMeasures(p, plan) : measureRules(p, model);
  return { project: saveProject(p), lint: lint(p, model) };
}));

projects.put('/:id/measures', h((req) => {
  const p = load(req);
  const model = requireModel(p);
  p.measures = (req.body as MeasureSpec[]).map((m) => ({ ...m, expression: m.expression.replace(/^\s*=\s*/, '') }));
  return { project: saveProject(p), lint: lint(p, model) };
}));

projects.get('/:id/measures/check', h((req) => {
  const p = load(req);
  const model = requireModel(p);
  return { lint: lint(p, model), values: measureChecks({ ...p, model }) };
}));

// ---------- report ----------

projects.post('/:id/report/suggest', h(async (req) => {
  const p = load(req);
  const model = requireModel(p);
  if (!p.measures.length) throw fail(400, 'Create the measures first');
  let issues: string[] = [];
  if (useAi(req)) {
    const res = await aiReport(p, model, p.measures);
    p.report = res.report;
    issues = res.issues;
  } else {
    const plan = collectionsReady(p);
    p.report =
      plan && model.tables.some((t) => t.name === MASTER) && p.measures.some((m) => m.name === 'Accounts in Collection')
        ? collectionsReport(p, plan, p.measures)
        : reportRules(p, model, p.measures);
  }
  return { project: saveProject(p), issues };
}));

projects.put('/:id/report', h((req) => {
  const p = load(req);
  const body = req.body as ReportSpec;
  const issues: string[] = [];
  const pages = reportPages(body).map((page) => ({
    ...page,
    id: page.id || newId(),
    name: page.name?.trim() || 'Page',
    visuals: page.visuals.map((v) => {
      const res = normalizeVisual({ ...v, id: v.id || newId() });
      issues.push(...res.issues);
      return res.visual;
    }),
  }));
  const { visuals: _legacy, ...rest } = body;
  p.report = { ...rest, pages, source: 'user' };
  return { project: saveProject(p), issues };
}));

projects.get('/:id/report/preview', h((req) => {
  const p = load(req);
  if (!p.report) throw fail(400, 'Design the dashboard first');
  const model = requireModel(p);
  return {
    pages: reportPages(p.report).map((page) => ({ id: page.id, layout: layoutPage(page) })),
    data: reportPreview({ ...p, model }, p.report),
  };
}));

// ---------- export ----------

projects.post('/:id/export', h(async (req) => {
  const p = load(req);
  requireModel(p);
  return exportProject(p);
}));

/** The latest export is found on disk, so it survives server restarts and page reloads. */
function existingExport(p: Project) {
  const loc = exportLocation(p);
  if (!fs.existsSync(loc.projectFile)) throw fail(404, 'No export yet — click "Generate Power BI project" first');
  return loc;
}

projects.get('/:id/export/status', h((req) => {
  const p = load(req);
  const loc = exportLocation(p);
  return {
    exists: fs.existsSync(loc.projectFile),
    ...loc,
    zipExists: fs.existsSync(loc.zipPath),
    powerBiDesktop: findPowerBiDesktop(),
  };
}));

projects.get('/:id/export/download', (req, res, next) => {
  try {
    const loc = existingExport(getProject(req.params.id));
    if (!fs.existsSync(loc.zipPath)) throw fail(404, 'Generate the project again to create the zip');
    res.download(loc.zipPath, path.basename(loc.zipPath));
  } catch (e) {
    next(e);
  }
});

projects.post('/:id/export/open', h(async (req) => {
  const loc = existingExport(load(req));
  if (req.body?.target === 'pbip') {
    const res = await openInPowerBi(loc.projectFile);
    return { ok: true, target: loc.projectFile, ...res };
  }
  await openFolder(loc.folder);
  return { ok: true, target: loc.folder };
}));
