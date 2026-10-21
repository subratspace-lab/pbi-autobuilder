import type { LayoutBox, PageSpec, ReportLayout, ReportSpec, VisualSpec, VisualType } from '../../../shared/types.js';

// Visual "template library": the data roles each Power BI visual accepts and a
// grid layout engine that places visuals the way a dashboard designer would.

export const VISUAL_ROLES: Record<VisualType, { category: string[]; values: string[]; max?: Record<string, number> }> = {
  card: { category: [], values: ['Values'], max: { Values: 1 } },
  multiRowCard: { category: [], values: ['Values'] },
  lineChart: { category: ['Category', 'Series'], values: ['Y'], max: { Category: 1, Series: 1 } },
  clusteredBarChart: { category: ['Category', 'Series'], values: ['Y'], max: { Category: 1, Series: 1 } },
  clusteredColumnChart: { category: ['Category', 'Series'], values: ['Y'], max: { Category: 1, Series: 1 } },
  donutChart: { category: ['Category'], values: ['Y'], max: { Category: 1, Y: 1 } },
  pivotTable: { category: ['Rows', 'Columns'], values: ['Values'] },
  tableEx: { category: [], values: ['Values'] },
  map: { category: ['Category'], values: ['Size'], max: { Category: 1, Size: 1 } },
  slicer: { category: ['Values'], values: [], max: { Values: 1 } },
};

export function categoryRoles(type: VisualType) {
  return VISUAL_ROLES[type].category;
}

export function valueRoles(type: VisualType) {
  return VISUAL_ROLES[type].values;
}

/** Drops fields placed in roles the visual does not have, enforces role limits. */
export function normalizeVisual(v: VisualSpec): { visual: VisualSpec; issues: string[] } {
  const roles = VISUAL_ROLES[v.type];
  const allowed = new Set([...roles.category, ...roles.values]);
  const issues: string[] = [];
  const counts: Record<string, number> = {};
  const fields = v.fields.filter((f) => {
    if (!allowed.has(f.role)) {
      issues.push(`"${v.title}": role "${f.role}" is not valid for ${v.type} — removed`);
      return false;
    }
    if (v.type === 'slicer' && f.field.kind === 'measure') {
      issues.push(`"${v.title}": slicers need a column, not a measure — removed`);
      return false;
    }
    if (roles.values.includes(f.role) && v.type !== 'tableEx' && v.type !== 'pivotTable' && f.field.kind !== 'measure') {
      issues.push(`"${v.title}": "${f.field.name}" in ${f.role} should be a measure — removed`);
      return false;
    }
    counts[f.role] = (counts[f.role] ?? 0) + 1;
    const max = roles.max?.[f.role];
    if (max && counts[f.role] > max) {
      issues.push(`"${v.title}": only ${max} field(s) allowed in ${f.role}`);
      return false;
    }
    return true;
  });
  if (!fields.length) issues.push(`"${v.title}" has no fields and will be skipped`);
  return { visual: { ...v, fields }, issues };
}

// ---------- layout ----------

const PAGE_W = 1280;
const MARGIN = 16;
const GAP = 12;
const HEADER_H = 64;
const SLICER_W = 210;
const CARD_H = 112;
const CHART_H = 290;
const TABLE_H = 300;

function group(type: VisualType): 'slicer' | 'card' | 'chart' | 'table' {
  if (type === 'slicer') return 'slicer';
  if (type === 'card' || type === 'multiRowCard') return 'card';
  if (type === 'pivotTable' || type === 'tableEx') return 'table';
  return 'chart';
}

export function layoutPage(page: PageSpec): ReportLayout {
  const boxes: LayoutBox[] = [{ id: '__title', x: MARGIN, y: MARGIN / 2, width: PAGE_W - 2 * MARGIN, height: HEADER_H - 8 }];
  const visuals = page.visuals.filter((v) => v.fields.length);
  const slicers = visuals.filter((v) => group(v.type) === 'slicer');
  const cards = visuals.filter((v) => group(v.type) === 'card');
  const charts = visuals.filter((v) => group(v.type) === 'chart');
  const tables = visuals.filter((v) => group(v.type) === 'table');

  const top = HEADER_H + 4;
  const left = slicers.length ? MARGIN + SLICER_W + GAP : MARGIN;
  const contentW = PAGE_W - left - MARGIN;
  let y = top;

  if (cards.length) {
    const perRow = Math.min(cards.length, 6);
    const w = (contentW - GAP * (perRow - 1)) / perRow;
    cards.forEach((c, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      boxes.push({ id: c.id, x: left + col * (w + GAP), y: y + row * (CARD_H + GAP), width: w, height: CARD_H });
    });
    y += Math.ceil(cards.length / perRow) * (CARD_H + GAP);
  }

  if (charts.length) {
    const perRow = charts.length === 1 ? 1 : charts.length % 3 === 0 ? 3 : 2;
    const w = (contentW - GAP * (perRow - 1)) / perRow;
    charts.forEach((c, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // A wide first chart (usually the trend) looks better when the count is odd.
      const isLastOdd = perRow === 2 && charts.length % 2 === 1 && i === charts.length - 1;
      boxes.push({
        id: c.id,
        x: left + col * (w + GAP),
        y: y + row * (CHART_H + GAP),
        width: isLastOdd ? contentW : w,
        height: CHART_H,
      });
    });
    y += Math.ceil(charts.length / perRow) * (CHART_H + GAP);
  }

  // A table that is the main content of a page (working lists) gets the rest of the page.
  const tableH = tables.length === 1 && charts.length <= 2 ? Math.max(TABLE_H, 720 - MARGIN - y) : TABLE_H;
  for (const t of tables) {
    boxes.push({ id: t.id, x: left, y, width: contentW, height: tableH });
    y += tableH + GAP;
  }

  const contentBottom = y - GAP + MARGIN;
  const slicerH = 74;
  slicers.forEach((s, i) => {
    boxes.push({ id: s.id, x: MARGIN, y: top + i * (slicerH + GAP), width: SLICER_W, height: slicerH });
  });
  const slicerBottom = top + slicers.length * (slicerH + GAP) + MARGIN;

  const height = Math.max(720, Math.ceil(Math.max(contentBottom, slicerBottom) / 10) * 10);
  return { width: PAGE_W, height, boxes: boxes.map((b) => ({ ...b, x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width) })) };
}

export const DEFAULT_THEME = {
  name: 'PBI AutoBuilder',
  dataColors: ['#2563EB', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4', '#EC4899', '#84CC16'],
  background: '#FFFFFF',
  foreground: '#1F2937',
  tableAccent: '#2563EB',
};

/** Every page of a report (older single-page specs included). */
export function reportPages(report: ReportSpec): PageSpec[] {
  if (report.pages?.length) return report.pages;
  return [{ id: 'page1', name: 'Dashboard', visuals: report.visuals ?? [] }];
}

export function allVisuals(report: ReportSpec): VisualSpec[] {
  return reportPages(report).flatMap((p) => p.visuals);
}
