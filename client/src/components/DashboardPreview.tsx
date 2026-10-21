import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronDown, Map as MapIcon } from 'lucide-react';
import type { MeasureSpec, PageSpec, PreviewData, ReportLayout, ReportSpec, VisualSpec } from '@shared/types';
import { formatValue } from './ui';

interface Props {
  report: ReportSpec;
  page: PageSpec;
  pageIndex: number;
  layout: ReportLayout;
  data: PreviewData;
  measures: MeasureSpec[];
}

function fmtFor(measures: MeasureSpec[], name: string) {
  return measures.find((m) => m.name === name)?.formatString;
}

function VisualBody({ v, data, pageId, colors, measures }: { v: VisualSpec; data: PreviewData; pageId: string; colors: string[]; measures: MeasureSpec[] }) {
  const series = data.visuals[v.id];
  const totals = data.measures[pageId] ?? {};
  const valueFields = v.fields.filter((f) => f.field.kind === 'measure');
  const tick = { fontSize: 10, fill: '#64748b' };
  const fmt = (name: string) => (x: number) => formatValue(x, fmtFor(measures, name));

  if (v.type === 'card') {
    const f = valueFields[0];
    const value = f ? totals[f.field.name] : null;
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-[28px] font-semibold leading-none" style={{ color: colors[0] }}>
          {value === null || value === undefined ? '…' : formatValue(value, fmtFor(measures, f!.field.name))}
        </div>
        <div className="mt-1.5 text-xs text-slate-500">{v.title}</div>
        {(value === null || value === undefined) && <div className="text-[10px] text-slate-400">computed in Power BI</div>}
      </div>
    );
  }
  if (v.type === 'multiRowCard') {
    return (
      <div className="space-y-1 p-2">
        {valueFields.map((f) => (
          <div key={f.field.name} className="flex justify-between text-xs">
            <span className="text-slate-500">{f.field.name}</span>
            <span className="font-semibold">{formatValue(totals[f.field.name], fmtFor(measures, f.field.name))}</span>
          </div>
        ))}
      </div>
    );
  }
  if (v.type === 'slicer') {
    const f = v.fields[0];
    return (
      <div className="px-2">
        <div className="mb-1 text-[11px] font-semibold text-slate-600">{f?.field.name}</div>
        <div className="flex items-center justify-between rounded border border-slate-300 px-2 py-1 text-xs text-slate-500">
          All <ChevronDown className="h-3 w-3" />
        </div>
      </div>
    );
  }
  if (v.type === 'map') {
    return (
      <div className="flex h-full items-center justify-center text-slate-300">
        <MapIcon className="h-12 w-12" />
      </div>
    );
  }
  const table = data.tables[v.id];
  if (v.type === 'tableEx' && table) {
    return (
      <div className="h-full overflow-auto px-2 text-[10px]">
        <table className="w-full">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b-2" style={{ borderColor: colors[0] }}>
              {table.headers.map((h) => (
                <th key={h} className="whitespace-nowrap px-1 py-1 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100">
                {r.map((c, k) => (
                  <td key={k} className="whitespace-nowrap px-1 py-0.5">
                    {c === null ? '' : typeof c === 'number' ? c.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="py-1 text-slate-400">{table.total.toLocaleString()} rows</div>
      </div>
    );
  }
  if (!series || !series.length) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">Preview not available for this visual — it renders with real data in Power BI.</div>;
  }
  const rows = series.map((s) => ({ category: s.category, ...s.values }));

  if (v.type === 'pivotTable' || v.type === 'tableEx') {
    return (
      <div className="h-full overflow-auto px-2 text-[11px]">
        <table className="w-full">
          <thead>
            <tr className="border-b-2" style={{ borderColor: colors[0] }}>
              <th className="py-1 text-left">{v.fields.find((f) => f.field.kind === 'column')?.field.name}</th>
              {valueFields.map((f) => (
                <th key={f.field.name} className="py-1 text-right">
                  {f.field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-b border-slate-100">
                <td className="py-1">{r.category}</td>
                {valueFields.map((f) => (
                  <td key={f.field.name} className="py-1 text-right tabular-nums">
                    {formatValue((r as Record<string, unknown>)[f.field.name] as number, fmtFor(measures, f.field.name))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (v.type === 'donutChart') {
    const name = valueFields[0]?.field.name ?? '';
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey={name} nameKey="category" innerRadius="50%" outerRadius="80%" paddingAngle={1}>
            {rows.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(x: number) => fmt(name)(x)} />
          <Legend wrapperStyle={{ fontSize: 10 }} iconSize={8} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (v.type === 'lineChart') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="category" tick={tick} />
          <YAxis tick={tick} tickFormatter={fmt(valueFields[0]?.field.name ?? '')} width={52} />
          <Tooltip formatter={(x: number, n: string) => fmt(n)(x)} />
          {valueFields.map((f, i) => (
            <Line key={f.field.name} dataKey={f.field.name} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }
  const horizontal = v.type === 'clusteredBarChart';
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
        {horizontal ? (
          <>
            <XAxis type="number" tick={tick} tickFormatter={fmt(valueFields[0]?.field.name ?? '')} />
            <YAxis type="category" dataKey="category" tick={tick} width={90} />
          </>
        ) : (
          <>
            <XAxis dataKey="category" tick={tick} />
            <YAxis tick={tick} tickFormatter={fmt(valueFields[0]?.field.name ?? '')} width={52} />
          </>
        )}
        <Tooltip formatter={(x: number, n: string) => fmt(n)(x)} />
        {valueFields.map((f, i) => (
          <Bar key={f.field.name} dataKey={f.field.name} fill={colors[i % colors.length]} radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DashboardPreview({ report, page, pageIndex, layout, data, measures }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / layout.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.width]);

  const colors = report.theme.dataColors;
  return (
    <div ref={wrap} className="w-full overflow-hidden rounded-xl border border-slate-200 shadow-sm" style={{ height: layout.height * scale }}>
      <div className="relative origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})`, background: '#F3F5F9' }}>
        {layout.boxes.map((b) => {
          if (b.id === '__title') {
            return (
              <div key={b.id} className="absolute flex flex-col justify-center px-2" style={{ left: b.x, top: b.y, width: b.width, height: b.height }}>
                <div className="text-[22px] font-bold" style={{ color: report.theme.foreground }}>
                  {pageIndex === 0 ? report.title : page.name}
                </div>
                <div className="text-xs text-slate-500">{page.subtitle ?? (pageIndex === 0 ? report.subtitle : report.title)}</div>
              </div>
            );
          }
          const v = page.visuals.find((x) => x.id === b.id);
          if (!v) return null;
          return (
            <div
              key={b.id}
              className="absolute flex flex-col overflow-hidden rounded-[10px] border border-slate-200 shadow-sm"
              style={{ left: b.x, top: b.y, width: b.width, height: b.height, background: report.theme.background }}
            >
              {v.type !== 'card' && v.type !== 'slicer' && <div className="truncate px-3 pt-2 text-[12px] font-semibold text-slate-700">{v.title}</div>}
              <div className={`min-h-0 flex-1 ${v.type === 'slicer' ? 'pt-2' : 'p-1'}`}>
                <VisualBody v={v} data={data} pageId={page.id} colors={colors} measures={measures} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
