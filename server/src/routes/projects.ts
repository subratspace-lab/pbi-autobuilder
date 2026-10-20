import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Analysis, CleaningOp, MeasureSpec, ModelSpec, Project, ReportSpec, TableCleaning } from '../../../shared/types.js';
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
import { profileTable } from '../services/profile.js';
import { analysisRules, cleaningRules, measureRules, modelRules, newId, reportRules } from '../services/rules.js';
import { aiAnalyze, aiCleaning, aiMeasures, aiModel, aiReport } from '../services/ai.js';
import { MEASURE_TABLE, modelColumns, validateModel } from '../services/model.js';
import { lintMeasures } from '../services/dax.js';
import { measureChecks, reportPreview } from '../services/preview.js';
import { layoutReport, normalizeVisual } from '../services/report.js';
import { exportProject } from '../services/pbipWriter.js';
import { APP_ROOT } from '../services/paths.js';

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
    const dataChanged = !asBrief && files.some((f) => isDataFile(f.filename));
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
  p.analysis = useAi(req) ? await aiAnalyze(p) : analysisRules(p);
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
    suggested = Object.fromEntries(p.profiles.map((pr) => [pr.table, cleaningRules(pr)]));
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
    const res = validateModel(p, modelRules(p, pipes));
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
  p.measures = useAi(req) ? await aiMeasures(p, model) : measureRules(p, model);
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
    p.report = reportRules(p, model, p.measures);
  }
  return { project: saveProject(p), issues };
}));

projects.put('/:id/report', h((req) => {
  const p = load(req);
  const body = req.body as ReportSpec;
  const issues: string[] = [];
  const visuals = body.visuals.map((v) => {
    const res = normalizeVisual({ ...v, id: v.id || newId() });
    issues.push(...res.issues);
    return res.visual;
  });
  p.report = { ...body, visuals, source: 'user' };
  return { project: saveProject(p), issues };
}));

projects.get('/:id/report/preview', h((req) => {
  const p = load(req);
  if (!p.report) throw fail(400, 'Design the dashboard first');
  const model = requireModel(p);
  return { layout: layoutReport(p.report), data: reportPreview({ ...p, model }, p.report) };
}));

// ---------- export ----------

const lastExport = new Map<string, Awaited<ReturnType<typeof exportProject>>>();

projects.post('/:id/export', h(async (req) => {
  const p = load(req);
  requireModel(p);
  const res = await exportProject(p);
  lastExport.set(p.id, res);
  return res;
}));

projects.get('/:id/export/download', (req, res, next) => {
  try {
    const p = getProject(req.params.id);
    const last = lastExport.get(p.id);
    if (!last || !fs.existsSync(last.zipPath)) throw fail(404, 'Export the project first');
    res.download(last.zipPath, path.basename(last.zipPath));
  } catch (e) {
    next(e);
  }
});

projects.post('/:id/export/open', h((req) => {
  const p = load(req);
  const last = lastExport.get(p.id);
  if (!last) throw fail(404, 'Export the project first');
  const target = req.body?.target === 'pbip' ? last.projectFile : last.folder;
  if (process.platform === 'win32') {
    spawn(req.body?.target === 'pbip' ? 'cmd.exe' : 'explorer.exe', req.body?.target === 'pbip' ? ['/c', 'start', '', target] : [target], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true, target };
}));
