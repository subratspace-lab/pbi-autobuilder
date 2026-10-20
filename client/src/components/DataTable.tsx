import { useMemo } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import type { Cell } from '@shared/types';

interface Props {
  headers: string[];
  rows: Cell[][];
  maxHeight?: number;
  highlight?: Set<string>;
}

function render(v: Cell) {
  if (v === null) return <span className="italic text-slate-300">null</span>;
  if (v === '') return <span className="italic text-slate-300">empty</span>;
  if (typeof v === 'string' && v !== v.trim()) return <span className="rounded bg-amber-100 px-0.5">{JSON.stringify(v)}</span>;
  if (typeof v === 'number') return <span className="tabular-nums">{v.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>;
  return String(v);
}

export function DataTable({ headers, rows, maxHeight = 420, highlight }: Props) {
  const columns = useMemo<ColumnDef<Cell[]>[]>(
    () =>
      headers.map((h, i) => ({
        id: `${i}`,
        header: h,
        accessorFn: (row) => row[i],
        cell: (info) => render(info.getValue() as Cell),
      })),
    [headers],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="scrollbar-thin overflow-auto rounded-lg border border-slate-200" style={{ maxHeight }}>
      <table className="min-w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-slate-100">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              <th className="border-b border-slate-200 px-2 py-2 text-right font-medium text-slate-400">#</th>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold text-slate-700 ${
                    highlight?.has(String(h.column.columnDef.header)) ? 'bg-emerald-100' : ''
                  }`}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} className="odd:bg-white even:bg-slate-50/60 hover:bg-brand-50/40">
              <td className="px-2 py-1.5 text-right text-slate-400">{r.index + 1}</td>
              {r.getVisibleCells().map((c) => (
                <td key={c.id} className="max-w-[260px] truncate whitespace-nowrap px-3 py-1.5 text-slate-700">
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="p-6 text-center text-sm text-slate-400">No rows</div>}
    </div>
  );
}
