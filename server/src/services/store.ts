import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Project, ProjectSummary, SourceTable, TableCleaning } from '../../../shared/types.js';
import { WORKSPACE } from './paths.js';
import { loadRawTable, type RawTable } from './ingest.js';
import { runPipeline, type PipelineOutput } from './cleaning.js';

const PROJECTS = path.join(WORKSPACE, 'projects');

export function projectDir(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid project id');
  return path.join(PROJECTS, id);
}

export function dataDir(id: string) {
  return path.join(projectDir(id), 'data');
}

export function briefDir(id: string) {
  return path.join(projectDir(id), 'brief');
}

export function listProjects(): ProjectSummary[] {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs
    .readdirSync(PROJECTS)
    .filter((d) => fs.existsSync(path.join(PROJECTS, d, 'project.json')))
    .map((d) => {
      const p = getProject(d);
      return { id: p.id, name: p.name, updatedAt: p.updatedAt, tables: p.tables.length };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createProject(name: string): Project {
  const id = crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const project: Project = {
    id,
    name: name.trim() || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    tables: [],
    brief: { text: '' },
    profiles: [],
    cleaning: [],
    cleanedSchemas: {},
    measures: [],
    export: { dataFolder: '', projectFileName: '' },
  };
  fs.mkdirSync(dataDir(id), { recursive: true });
  fs.mkdirSync(briefDir(id), { recursive: true });
  saveProject(project);
  return project;
}

export function getProject(id: string): Project {
  const file = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('Project not found'), { status: 404 });
  const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
  // Reports from older versions had a single list of visuals.
  if (project.report && !project.report.pages) {
    project.report.pages = [{ id: 'page1', name: 'Dashboard', visuals: project.report.visuals ?? [] }];
    delete project.report.visuals;
  }
  return project;
}

export function saveProject(project: Project): Project {
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir(project.id), 'project.json'), JSON.stringify(project, null, 2));
  return project;
}

export function deleteProject(id: string) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
  for (const key of rawCache.keys()) if (key.startsWith(`${id}:`)) rawCache.delete(key);
  for (const key of pipelineCache.keys()) if (key.startsWith(`${id}:`)) pipelineCache.delete(key);
}

// ---------- caches (raw files are re-parsed only when they change) ----------

const rawCache = new Map<string, RawTable>();
const pipelineCache = new Map<string, PipelineOutput>();
const MAX_PIPELINES = 30;

function rawKey(id: string, table: SourceTable) {
  const stat = fs.statSync(path.join(dataDir(id), table.file));
  return `${id}:${table.name}:${table.file}:${table.sheet ?? ''}:${stat.mtimeMs}`;
}

export function getRaw(id: string, table: SourceTable): RawTable {
  const key = rawKey(id, table);
  let raw = rawCache.get(key);
  if (!raw) {
    raw = loadRawTable(dataDir(id), table);
    rawCache.set(key, raw);
  }
  return raw;
}

export function defaultCleaning(project: Project, table: string): TableCleaning {
  const profile = project.profiles.find((p) => p.table === table);
  return { table, culture: profile?.culture ?? 'en-US', ops: [] };
}

export function getCleaning(project: Project, table: string): TableCleaning {
  return project.cleaning.find((c) => c.table === table) ?? defaultCleaning(project, table);
}

/** Sources pulled in by merge steps (directly or indirectly) from the given tables. */
export function mergedSources(project: Project, roots: string[]): Set<string> {
  const found = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const t = queue.shift()!;
    for (const op of getCleaning(project, t).ops) {
      if (op.enabled && op.op === 'mergeTable' && !found.has(op.table) && project.tables.some((x) => x.name === op.table)) {
        found.add(op.table);
        queue.push(op.table);
      }
    }
  }
  return found;
}

export function getPipeline(project: Project, tableName: string, visiting: string[] = []): PipelineOutput {
  const table = project.tables.find((t) => t.name === tableName);
  if (!table) throw Object.assign(new Error(`Table "${tableName}" not found`), { status: 404 });
  const cleaning = getCleaning(project, tableName);
  // Merges make a table depend on other tables: include them all in the cache key.
  const deps = [...mergedSources(project, [tableName])].map((n) => {
    const t = project.tables.find((x) => x.name === n)!;
    return `${rawKey(project.id, t)}:${JSON.stringify(getCleaning(project, n))}`;
  });
  const key = `${project.id}:${rawKey(project.id, table)}:${JSON.stringify(cleaning)}:${deps.join('|')}`;
  let out = pipelineCache.get(key);
  if (!out) {
    const path = [...visiting, tableName];
    const ctx = {
      resolve: (name: string) => (path.includes(name) || !project.tables.some((t) => t.name === name) ? null : getPipeline(project, name, path)),
    };
    out = runPipeline(table, getRaw(project.id, table), cleaning, ctx);
    if (pipelineCache.size >= MAX_PIPELINES) pipelineCache.delete(pipelineCache.keys().next().value!);
    pipelineCache.set(key, out);
  }
  return out;
}

/** Re-run every table's cleaning and remember the resulting schemas. */
export function refreshCleanedSchemas(project: Project) {
  project.cleanedSchemas = {};
  for (const t of project.tables) {
    project.cleanedSchemas[t.name] = getPipeline(project, t.name).columns;
  }
}
