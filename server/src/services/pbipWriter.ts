import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import Handlebars from 'handlebars';
import type { ExportCheck, MeasureCheck, Project, ReportSpec, VisualSpec } from '../../../shared/types.js';
import { buildTmdl, embeddedSourceSteps } from './tmdl.js';
import { buildReport, columnTypeIndex } from './pbir.js';
import { buildModelData, modelColumns, validateModel } from './model.js';
import { dataDir, getPipeline, getRaw, mergedSources, projectDir } from './store.js';
import { lintMeasures } from './dax.js';
import { MEASURE_TABLE } from './model.js';
import { measureChecks } from './preview.js';
import { normalizeVisual, reportPages } from './report.js';
import { SERVER_ROOT } from './paths.js';
import type { PipelineOutput } from './cleaning.js';

export function safeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim() || 'Dashboard';
}

export interface ExportResult {
  folder: string;
  zipPath: string;
  projectFile: string;
  dataFolder: string;
  rowChecks: ExportCheck[];
  measureChecks: MeasureCheck[];
  warnings: string[];
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function zipFolder(folder: string, zipPath: string, rootName: string) {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve());
    zip.on('error', reject);
    zip.pipe(out);
    zip.directory(folder, rootName);
    void zip.finalize();
  });
}

Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

function formatNumber(v: number | null | undefined) {
  if (typeof v !== 'number') return undefined;
  return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 });
}

function readmeTemplate() {
  return Handlebars.compile(fs.readFileSync(path.join(SERVER_ROOT, 'src', 'templates', 'README.md.hbs'), 'utf8'), { noEscape: true });
}

/**
 * A double-click launcher for whoever receives the zip. It refuses to run from
 * inside the zip (Windows would only extract the clicked file), points the
 * DataFolder parameter at the bundled Data folder on *this* PC, then opens the .pbip.
 */
function launcherFiles(name: string, smFolder: string): Record<string, string> {
  const cmd = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    `if not exist "%~dp0${name}.Report\\definition.pbir" goto notextracted`,
    `if not exist "%~dp0${smFolder}\\definition\\expressions.tmdl" goto notextracted`,
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\set-data-folder.ps1"',
    'if errorlevel 1 goto failed',
    `start "" "%~dp0${name}.pbip"`,
    'exit /b 0',
    ':notextracted',
    'echo.',
    'echo  This file must be run from the EXTRACTED folder, not from inside the zip.',
    'echo  Right-click the .zip file ^> Extract All... then open the extracted folder',
    'echo  and double-click "Open in Power BI.cmd" again.',
    'echo.',
    'pause',
    'exit /b 1',
    ':failed',
    'echo.',
    'echo  Could not update the data folder path. Open the .pbip manually and set',
    'echo  Transform data ^> Edit parameters ^> DataFolder to the Data folder.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');

  const ps1 = [
    '# Points the DataFolder parameter at the Data folder next to this project.',
    "$ErrorActionPreference = 'Stop'",
    '$root = Split-Path -Parent $PSScriptRoot',
    `$file = Join-Path $root '${smFolder.replace(/'/g, "''")}\\definition\\expressions.tmdl'`,
    "$data = (Join-Path $root 'Data') + '\\'",
    '$text = [IO.File]::ReadAllText($file)',
    "$escaped = $data.Replace('\"', '\"\"')",
    "$new = [regex]::Replace($text, '(?m)^expression DataFolder = \"(?:[^\"]|\"\")*\"', { param($m) 'expression DataFolder = \"' + $escaped + '\"' })",
    'if ($new -ne $text) { [IO.File]::WriteAllText($file, $new, (New-Object System.Text.UTF8Encoding($false))) }',
    "Write-Host \"DataFolder set to $data\"",
    '',
  ].join('\r\n');

  return { 'Open in Power BI.cmd': cmd, 'tools/set-data-folder.ps1': ps1, ...howToFile(name, false) };
}

function howToFile(name: string, embedded: boolean): Record<string, string> {
  const steps = embedded
    ? [
        '1. Right-click the .zip file > Extract All...   (do NOT open files from inside the zip)',
        `2. In the extracted folder, double-click  "${name}.pbip"`,
        '3. You will first see "(Blank)" everywhere and a yellow bar saying objects "need to be manually refreshed".',
        '   That is normal: click  Refresh now  (or Home > Refresh) once. The data is built into the project - no files or paths needed.',
        '4. File > Save as > Power BI file (.pbix)',
      ]
    : [
        '1. Right-click the .zip file > Extract All...   (do NOT open files from inside the zip)',
        '2. In the extracted folder, double-click  "Open in Power BI.cmd"',
        '   - it points the report at the Data folder on this PC and opens Power BI Desktop',
        '3. You will first see "(Blank)" everywhere and a yellow "needs to be manually refreshed" bar - that is normal:',
        '   click  Refresh now  (or Home > Refresh) once.',
        '4. File > Save as > Power BI file (.pbix)',
      ];
  const text = [`HOW TO OPEN "${name}"`, '', ...steps, '', 'Needs Power BI Desktop (free, Microsoft Store). See README.md for details.', ''];
  return { 'HOW TO OPEN.txt': text.join('\r\n') };
}

/** ~40 MB of compressed text in the model is still comfortable for Power BI Desktop. */
const MAX_EMBED_CHARS = 40_000_000;

/** Where a project's export lives (same rules as exportProject). */
export function exportLocation(project: Project) {
  const name = safeFileName(project.export.projectFileName || project.name);
  const exportRoot = path.join(projectDir(project.id), 'export');
  const folder = path.join(exportRoot, name);
  return { name, folder, projectFile: path.join(folder, `${name}.pbip`), zipPath: path.join(exportRoot, `${name}.zip`) };
}

export async function exportProject(project: Project): Promise<ExportResult> {
  if (!project.model) throw new Error('Build the data model first');
  if (!project.report) throw new Error('Design the dashboard first');
  const warnings: string[] = [];
  const { model, issues } = validateModel(project, project.model);
  warnings.push(...issues);

  const tables = modelColumns(project, model);
  const lint = lintMeasures(project.measures, tables, MEASURE_TABLE);
  const badMeasures = new Set(lint.filter((l) => l.level === 'error').map((l) => l.measure));
  for (const l of lint.filter((x) => x.level === 'error')) warnings.push(`Measure "${l.measure}" left out: ${l.message}`);
  const measures = project.measures.filter((m) => !badMeasures.has(m.name));

  const measureNames = new Set(measures.map((m) => m.name));
  const hasColumn = (table: string, column: string) => Boolean(tables.get(table)?.some((c) => c.name === column));
  const cleanVisuals = (list: VisualSpec[]) =>
    list
    .map((v) => {
      const fields = v.fields.filter((f) => {
        const ok = f.field.kind === 'measure' ? measureNames.has(f.field.name) : hasColumn(f.field.table, f.field.name);
        if (!ok) warnings.push(`Visual "${v.title}": field "${f.field.name}" no longer exists — removed`);
        return ok;
      });
      const { visual, issues: vIssues } = normalizeVisual({ ...v, fields, id: v.id.replace(/[^A-Za-z0-9]/g, '') || v.id });
      warnings.push(...vIssues);
      return visual;
    })
    .filter((v) => v.fields.length);
  const pages = reportPages(project.report).map((p) => ({
    ...p,
    visuals: cleanVisuals(p.visuals),
    filters: p.filters?.filter((f) => {
      const ok = hasColumn(f.table, f.column);
      if (!ok) warnings.push(`Page "${p.name}": filter on ${f.table}[${f.column}] refers to a missing column — removed`);
      return ok;
    }),
  }));
  const report: ReportSpec = { ...project.report, pages };

  const name = safeFileName(project.export.projectFileName || project.name);
  const exportRoot = path.join(projectDir(project.id), 'export');
  const folder = path.join(exportRoot, name);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });

  // Copy the raw data next to the project so the whole folder is portable.
  const dataOut = path.join(folder, 'Data');
  fs.mkdirSync(dataOut, { recursive: true });
  for (const f of new Set(project.tables.filter((t) => t.kind !== 'sql').map((t) => t.file))) fs.copyFileSync(path.join(dataDir(project.id), f), path.join(dataOut, f));
  const dataFolder = project.export.dataFolder.trim() || dataOut;

  // Model sources plus every table merged into them (those become staging queries).
  const merged = mergedSources(project, model.tables.map((t) => t.source));
  const pipelines = new Map<string, PipelineOutput>();
  for (const source of new Set([...model.tables.map((t) => t.source), ...merged])) pipelines.set(source, getPipeline(project, source));

  // Embed the raw data in the queries (default) so refresh works on any PC
  // without files or paths. Very large data falls back to the Data folder.
  let embedded: Map<string, { name: string; expr: string }[]> | undefined;
  if (project.export.embedData !== false) {
    embedded = new Map();
    let size = 0;
    for (const [source, pipe] of pipelines) {
      const table = project.tables.find((t) => t.name === source)!;
      // SQL Server tables stay live unless the user chose a snapshot.
      if (table.kind === 'sql' && project.export.liveSql !== false) continue;
      const steps = embeddedSourceSteps(getRaw(project.id, table), pipe.steps[pipe.sourceStepCount - 1].name);
      size += steps[0].expr.length;
      embedded.set(source, steps);
    }
    if (size > MAX_EMBED_CHARS) {
      warnings.push(`Data is too large to embed (${Math.round(size / 1e6)} MB compressed) — the report reads it from the Data folder instead.`);
      embedded = undefined;
    }
  }

  const smFolder = `${name}.SemanticModel`;
  const rpFolder = `${name}.Report`;
  const tmdl = buildTmdl(project, model, measures, pipelines, dataFolder, embedded, merged);
  writeFiles(path.join(folder, smFolder), {
    'definition.pbism': JSON.stringify(
      {
        $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
        version: '4.0',
        settings: {},
      },
      null,
      2,
    ),
    ...Object.fromEntries(Object.entries(tmdl).map(([k, v]) => [`definition/${k}`, v])),
  });
  writeFiles(path.join(folder, rpFolder), buildReport(report, smFolder, columnTypeIndex(tables)));
  writeFiles(folder, {
    [`${name}.pbip`]: JSON.stringify(
      {
        $schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
        version: '1.0',
        artifacts: [{ report: { path: rpFolder } }],
        settings: { enableAutoRecovery: true },
      },
      null,
      2,
    ),
    '.gitignore': '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n',
    ...(embedded ? howToFile(name, true) : launcherFiles(name, smFolder)),
  });

  // Checks the user can compare with Power BI after refresh.
  const modelData = buildModelData(project, model);
  const rowChecks: ExportCheck[] = model.tables.map((t) => ({ table: t.name, rows: modelData.get(t.name)?.rows.length ?? 0 }));
  const checks = measureChecks({ ...project, model, measures });

  const readme = readmeTemplate()({
    name,
    projectName: project.name,
    generatedAt: new Date().toLocaleString(),
    dataFolder,
    embedded: Boolean(embedded),
    sqlSources: [...new Set(project.tables.filter((t) => t.sql && !embedded?.has(t.name) && pipelines.has(t.name)).map((t) => `${t.sql!.server} / ${t.sql!.database}`))],
    analysis: project.analysis,
    tables: project.tables.map((t) => {
      const pipe = pipelines.get(t.name) ?? getPipeline(project, t.name);
      return { name: t.name, file: t.file, rowsBefore: pipe.rowsBefore, rowsAfter: pipe.rowsAfter, steps: pipe.stepStats };
    }),
    model,
    relationships: model.relationships,
    measures: measures.map((m) => ({ ...m, value: formatNumber(checks.find((c) => c.name === m.name)?.value) })),
    rowChecks,
    pages: reportPages(report).map((p) => ({
      name: p.name,
      filterText: (p.filters ?? []).map((f) => `${f.table}[${f.column}] in (${f.values.join(', ')})`).join('; '),
      visuals: p.visuals.map((v) => ({
        ...v,
        fieldList: v.fields.map((f) => `${f.role}: ${f.field.kind === 'measure' ? `[${f.field.name}]` : `${f.field.table}[${f.field.name}]`}`).join(', '),
      })),
    })),
    report,
    warnings,
  });
  fs.writeFileSync(path.join(folder, 'README.md'), readme, 'utf8');

  const zipPath = path.join(exportRoot, `${name}.zip`);
  fs.rmSync(zipPath, { force: true });
  await zipFolder(folder, zipPath, name);

  return {
    folder,
    zipPath,
    projectFile: path.join(folder, `${name}.pbip`),
    dataFolder,
    rowChecks,
    measureChecks: checks,
    warnings,
  };
}
