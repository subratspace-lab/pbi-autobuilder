import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CleanedColumn, FieldRef, ReportSpec, ThemeSpec, VisualSpec } from '../../../shared/types.js';
import { layoutReport } from './report.js';
import { REFERENCE_DIR } from './paths.js';

// Writes the report in PBIR (enhanced report format): one JSON file per page
// and per visual. Field references point at the TMDL model.

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition';
const BASE_THEME = 'CY24SU10';
const CUSTOM_THEME = 'AutoBuilderTheme.json';

const hexId = () => crypto.randomBytes(10).toString('hex');

const lit = (v: string) => ({ expr: { Literal: { Value: v } } });
const litText = (s: string) => lit(`'${s.replace(/'/g, "''")}'`);

function fieldExpr(f: FieldRef) {
  const source = { Expression: { SourceRef: { Entity: f.table } }, Property: f.name };
  return f.kind === 'measure' ? { Measure: source } : { Column: source };
}

function projection(f: FieldRef) {
  return { field: fieldExpr(f), queryRef: `${f.table}.${f.name}`, nativeQueryRef: f.name };
}

function containerTitle(title: string) {
  return {
    title: [{ properties: { show: lit('true'), text: litText(title) } }],
  };
}

function visualJson(v: VisualSpec, box: { x: number; y: number; width: number; height: number }, z: number, columnTypes: Map<string, string>) {
  const roles: Record<string, { projections: ReturnType<typeof projection>[] }> = {};
  for (const f of v.fields) {
    (roles[f.role] ??= { projections: [] }).projections.push(projection(f.field));
  }
  const visual: Record<string, unknown> = {
    visualType: v.type,
    query: { queryState: roles },
    drillFilterOtherVisuals: true,
  };
  const objects: Record<string, unknown> = {};

  if (v.type === 'slicer') {
    const f = v.fields[0]?.field;
    const type = f ? columnTypes.get(`${f.table}|${f.name}`) : undefined;
    const mode = type === 'date' || type === 'datetime' ? 'Between' : 'Dropdown';
    objects.data = [{ properties: { mode: litText(mode) } }];
    objects.header = [{ properties: { show: lit('true') } }];
  }
  if (v.sortDescending && ['clusteredBarChart', 'clusteredColumnChart', 'donutChart'].includes(v.type)) {
    const y = v.fields.find((f) => f.role === 'Y');
    if (y) {
      (visual.query as Record<string, unknown>).sortDefinition = {
        sort: [{ field: fieldExpr(y.field), direction: 'Descending' }],
        isDefaultSort: true,
      };
    }
  }
  if (v.type === 'lineChart' || v.type === 'clusteredColumnChart' || v.type === 'clusteredBarChart') {
    objects.labels = [{ properties: { show: lit(v.type === 'lineChart' ? 'false' : 'true') } }];
  }
  if (v.type === 'donutChart') {
    objects.labels = [{ properties: { show: lit('true'), labelStyle: litText('Category, percent of total') } }];
  }
  if (Object.keys(objects).length) visual.objects = objects;
  visual.visualContainerObjects = containerTitle(v.title);

  return {
    $schema: `${SCHEMA}/visualContainer/1.0.0/schema.json`,
    name: v.id,
    position: { x: box.x, y: box.y, z, height: box.height, width: box.width, tabOrder: z },
    visual,
  };
}

function titleTextbox(report: ReportSpec, box: { x: number; y: number; width: number; height: number }) {
  const paragraphs = [
    { textRuns: [{ value: report.title, textStyle: { fontWeight: 'bold', fontSize: '20pt' } }] },
  ];
  if (report.subtitle) paragraphs.push({ textRuns: [{ value: report.subtitle, textStyle: { fontSize: '11pt' } as never }] });
  return {
    $schema: `${SCHEMA}/visualContainer/1.0.0/schema.json`,
    name: 'title' + hexId().slice(0, 12),
    position: { x: box.x, y: box.y, z: 0, height: box.height, width: box.width, tabOrder: 0 },
    visual: {
      visualType: 'textbox',
      objects: { general: [{ properties: { paragraphs } }] },
      visualContainerObjects: { background: [{ properties: { show: lit('false') } }] },
    },
  };
}

export function themeJson(theme: ThemeSpec) {
  const solid = (color: string) => ({ solid: { color } });
  return {
    name: theme.name,
    dataColors: theme.dataColors,
    background: theme.background,
    foreground: theme.foreground,
    tableAccent: theme.tableAccent,
    textClasses: {
      callout: { fontSize: 26, fontFace: 'Segoe UI Semibold', color: theme.foreground },
      title: { fontSize: 12, fontFace: 'Segoe UI Semibold', color: theme.foreground },
      label: { fontSize: 10, fontFace: 'Segoe UI', color: theme.foreground },
    },
    visualStyles: {
      '*': {
        '*': {
          background: [{ show: true, color: solid(theme.background), transparency: 0 }],
          border: [{ show: true, color: solid('#E5E7EB'), radius: 10 }],
          dropShadow: [{ show: true, preset: 'Bottom' }],
          visualHeader: [{ show: true }],
          title: [{ show: true, fontSize: 12, fontColor: solid(theme.foreground) }],
        },
      },
      page: { '*': { background: [{ color: solid('#F3F5F9'), transparency: 0 }] } },
      card: { '*': { labels: [{ color: solid(theme.dataColors[0]), fontSize: 26 }], categoryLabels: [{ show: true }] } },
      slicer: { '*': { items: [{ fontColor: solid(theme.foreground) }] } },
    },
  };
}

function baseThemeFile(): { name: string; content: string } {
  // Prefer the real base theme harvested from a report saved by the installed
  // Power BI Desktop (drop a .pbip into server/reference/), so versions match.
  if (fs.existsSync(REFERENCE_DIR)) {
    const stack = [REFERENCE_DIR];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (path.basename(dir) === 'BaseThemes' && entry.name.endsWith('.json')) {
          return { name: entry.name.replace(/\.json$/, ''), content: fs.readFileSync(full, 'utf8') };
        }
      }
    }
  }
  return {
    name: BASE_THEME,
    content: JSON.stringify(
      {
        name: BASE_THEME,
        dataColors: ['#118DFF', '#12239E', '#E66C37', '#6B007B', '#E044A7', '#744EC2', '#D9B300', '#D64550'],
        foreground: '#252423',
        foregroundNeutralSecondary: '#605E5C',
        foregroundNeutralTertiary: '#B3B0AD',
        background: '#FFFFFF',
        backgroundLight: '#F3F2F1',
        backgroundNeutral: '#C8C6C4',
        tableAccent: '#118DFF',
        good: '#1AAB40',
        neutral: '#D9B300',
        bad: '#D64554',
        maximum: '#118DFF',
        center: '#D9B300',
        minimum: '#DEEFFF',
        null: '#FF7F48',
        hyperlink: '#0078d4',
        visitedHyperlink: '#0078d4',
        textClasses: {
          callout: { fontSize: 45, fontFace: 'DIN', color: '#252423' },
          title: { fontSize: 12, fontFace: 'DIN', color: '#252423' },
          header: { fontSize: 12, fontFace: 'Segoe UI Semibold', color: '#252423' },
          label: { fontSize: 10, fontFace: 'Segoe UI', color: '#252423' },
        },
        visualStyles: {},
      },
      null,
      2,
    ),
  };
}

export interface ReportFiles {
  [relativePath: string]: string;
}

export function buildReport(report: ReportSpec, semanticModelFolder: string, columnTypes: Map<string, string>): ReportFiles {
  const files: ReportFiles = {};
  const layout = layoutReport(report);
  const pageName = hexId();
  const base = baseThemeFile();

  files['definition.pbir'] = JSON.stringify(
    {
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/1.0.0/schema.json',
      version: '4.0',
      datasetReference: { byPath: { path: `../${semanticModelFolder}` } },
    },
    null,
    2,
  );
  files['definition/version.json'] = JSON.stringify(
    { $schema: `${SCHEMA}/versionMetadata/1.0.0/schema.json`, version: '2.0.0' },
    null,
    2,
  );
  files['definition/report.json'] = JSON.stringify(
    {
      $schema: `${SCHEMA}/report/1.0.0/schema.json`,
      themeCollection: {
        baseTheme: { name: base.name, reportVersionAtImport: '5.59', type: 'SharedResources' },
        customTheme: { name: CUSTOM_THEME, reportVersionAtImport: '5.59', type: 'RegisteredResources' },
      },
      layoutOptimization: 'None',
      resourcePackages: [
        {
          name: 'SharedResources',
          type: 'SharedResources',
          items: [{ name: base.name, path: `BaseThemes/${base.name}.json`, type: 'BaseTheme' }],
        },
        {
          name: 'RegisteredResources',
          type: 'RegisteredResources',
          items: [{ name: CUSTOM_THEME, path: CUSTOM_THEME, type: 'CustomTheme' }],
        },
      ],
      settings: {
        useStylableVisualContainerHeader: true,
        defaultDrillFilterOtherVisuals: true,
        allowChangeFilterTypes: true,
        useEnhancedTooltips: true,
      },
    },
    null,
    2,
  );
  files['definition/pages/pages.json'] = JSON.stringify(
    { $schema: `${SCHEMA}/pagesMetadata/1.0.0/schema.json`, pageOrder: [pageName], activePageName: pageName },
    null,
    2,
  );
  files[`definition/pages/${pageName}/page.json`] = JSON.stringify(
    {
      $schema: `${SCHEMA}/page/1.0.0/schema.json`,
      name: pageName,
      displayName: 'Dashboard',
      displayOption: 'FitToWidth',
      height: layout.height,
      width: layout.width,
    },
    null,
    2,
  );

  const titleBox = layout.boxes.find((b) => b.id === '__title')!;
  const title = titleTextbox(report, titleBox);
  files[`definition/pages/${pageName}/visuals/${title.name}/visual.json`] = JSON.stringify(title, null, 2);

  let z = 1;
  for (const v of report.visuals) {
    const box = layout.boxes.find((b) => b.id === v.id);
    if (!box || !v.fields.length) continue;
    files[`definition/pages/${pageName}/visuals/${v.id}/visual.json`] = JSON.stringify(visualJson(v, box, z * 1000, columnTypes), null, 2);
    z++;
  }

  files[`StaticResources/SharedResources/BaseThemes/${base.name}.json`] = base.content;
  files[`StaticResources/RegisteredResources/${CUSTOM_THEME}`] = JSON.stringify(themeJson(report.theme), null, 2);
  return files;
}

export function columnTypeIndex(tables: Map<string, CleanedColumn[]>) {
  const out = new Map<string, string>();
  for (const [t, cols] of tables) for (const c of cols) out.set(`${t}|${c.name}`, c.type);
  return out;
}
