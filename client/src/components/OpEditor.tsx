import { useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import type { CleaningOp, CleaningOpKind, ColumnType } from '@shared/types';

export const OP_LABELS: Record<CleaningOpKind, string> = {
  setType: 'Change type',
  trim: 'Trim spaces',
  clean: 'Remove non-printable chars',
  properCase: 'Capitalize Each Word',
  upperCase: 'UPPERCASE',
  lowerCase: 'lowercase',
  emptyToNull: 'Empty text → null',
  replaceValues: 'Replace values',
  replaceNulls: 'Fill nulls with value',
  removeDuplicates: 'Remove duplicates',
  removeBlankRows: 'Remove blank rows',
  removeRowsWithBlank: 'Remove rows with blank in column',
  fillDown: 'Fill down',
  splitColumn: 'Split column',
  addColumn: 'Add column',
  rename: 'Rename column',
  removeColumns: 'Remove columns',
  filterRows: 'Filter rows',
};

const TYPES: ColumnType[] = ['text', 'number', 'integer', 'currency', 'date', 'datetime', 'boolean'];
const OPERATORS = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', 'contains', 'notContains', 'isNotBlank'];

type FieldKind = 'column' | 'columns' | 'text' | 'value' | 'bool' | 'type' | 'operator' | 'list' | 'json';
const FIELDS: Record<CleaningOpKind, { key: string; kind: FieldKind; label: string }[]> = {
  setType: [
    { key: 'column', kind: 'column', label: 'Column' },
    { key: 'type', kind: 'type', label: 'Type' },
  ],
  trim: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  clean: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  properCase: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  upperCase: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  lowerCase: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  emptyToNull: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  fillDown: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  replaceValues: [
    { key: 'column', kind: 'column', label: 'Column' },
    { key: 'find', kind: 'value', label: 'Find' },
    { key: 'replace', kind: 'value', label: 'Replace with' },
    { key: 'wholeValue', kind: 'bool', label: 'Match whole cell' },
  ],
  replaceNulls: [
    { key: 'column', kind: 'column', label: 'Column' },
    { key: 'value', kind: 'value', label: 'Value' },
  ],
  removeDuplicates: [{ key: 'columns', kind: 'columns', label: 'Key columns (empty = whole row)' }],
  removeBlankRows: [],
  removeRowsWithBlank: [{ key: 'column', kind: 'column', label: 'Column' }],
  splitColumn: [
    { key: 'column', kind: 'column', label: 'Column' },
    { key: 'delimiter', kind: 'text', label: 'Delimiter' },
    { key: 'newColumns', kind: 'list', label: 'New column names (comma separated)' },
  ],
  addColumn: [
    { key: 'name', kind: 'text', label: 'New column name' },
    { key: 'spec', kind: 'json', label: 'Formula (JSON)' },
  ],
  rename: [
    { key: 'from', kind: 'column', label: 'Column' },
    { key: 'to', kind: 'text', label: 'New name' },
  ],
  removeColumns: [{ key: 'columns', kind: 'columns', label: 'Columns' }],
  filterRows: [
    { key: 'column', kind: 'column', label: 'Column' },
    { key: 'operator', kind: 'operator', label: 'Keep rows where' },
    { key: 'value', kind: 'value', label: 'Value' },
  ],
};

export const OP_TEMPLATES: Record<CleaningOpKind, Record<string, unknown>> = {
  setType: { column: '', type: 'number' },
  trim: { columns: [] },
  clean: { columns: [] },
  properCase: { columns: [] },
  upperCase: { columns: [] },
  lowerCase: { columns: [] },
  emptyToNull: { columns: [] },
  fillDown: { columns: [] },
  replaceValues: { column: '', find: '', replace: '', wholeValue: true },
  replaceNulls: { column: '', value: 'Unknown' },
  removeDuplicates: {},
  removeBlankRows: {},
  removeRowsWithBlank: { column: '' },
  splitColumn: { column: '', delimiter: ' ', newColumns: ['Part 1', 'Part 2'] },
  addColumn: { name: 'New Column', spec: { kind: 'arithmetic', left: '', operator: '-', right: '' } },
  rename: { from: '', to: '' },
  removeColumns: { columns: [] },
  filterRows: { column: '', operator: 'isNotBlank' },
};

export function describeOp(op: CleaningOp): string {
  const o = op as unknown as Record<string, unknown>;
  const cols = (o.columns as string[] | undefined)?.join(', ');
  switch (op.op) {
    case 'setType':
      return `${op.column} → ${op.type}`;
    case 'replaceValues':
      return `${op.column}: ${JSON.stringify(op.find)} → ${JSON.stringify(op.replace)}${op.wholeValue ? '' : ' (inside text)'}`;
    case 'replaceNulls':
      return `${op.column}: null → ${JSON.stringify(op.value)}`;
    case 'removeDuplicates':
      return cols ? `by ${cols}` : 'whole row';
    case 'removeBlankRows':
      return 'rows where every cell is empty';
    case 'removeRowsWithBlank':
      return op.column;
    case 'splitColumn':
      return `${op.column} by "${op.delimiter}" → ${op.newColumns.join(', ')}`;
    case 'addColumn': {
      const s = op.spec;
      const body =
        s.kind === 'arithmetic'
          ? `${s.left} ${s.operator} ${s.right}`
          : s.kind === 'datePart'
            ? `${s.part} of ${s.column}`
            : s.kind === 'concat'
              ? s.columns.join(` "${s.separator}" `)
              : s.kind === 'conditional'
                ? `if ${s.column} ${s.operator} ${s.value} then "${s.then}" else "${s.else}"`
                : s.kind === 'bucket'
                  ? `bands of ${s.column}: ${s.labels.join(' · ')}`
                  : s.mExpression;
      return `${op.name} = ${body}`;
    }
    case 'rename':
      return `${op.from} → ${op.to}`;
    case 'filterRows':
      return `${op.column} ${op.operator}${op.value !== undefined && op.operator !== 'isNotBlank' ? ` ${op.value}` : ''}`;
    default:
      return cols ?? '';
  }
}

function parseValue(s: string): string | number | null {
  if (s === 'null') return null;
  if (s.trim() !== '' && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

interface Props {
  op: CleaningOp;
  index: number;
  count: number;
  columns: string[];
  stat?: { rowsAfter: number; note?: string };
  skipped?: boolean;
  onChange: (op: CleaningOp) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  startOpen?: boolean;
}

export function OpEditor({ op, index, count, columns, stat, skipped, onChange, onMove, onDelete, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [jsonText, setJsonText] = useState<string | null>(null);
  const o = op as unknown as Record<string, unknown>;
  const set = (key: string, value: unknown) => onChange({ ...o, [key]: value } as unknown as CleaningOp);

  return (
    <div className={`card overflow-hidden ${!op.enabled ? 'opacity-60' : ''} ${skipped ? 'border-amber-300' : ''}`}>
      <div className="flex items-start gap-3 p-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={op.enabled} onChange={(e) => onChange({ ...op, enabled: e.target.checked })} title="Enable step" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">{index + 1}</span>
            <span className="font-medium text-slate-900">{OP_LABELS[op.op] ?? op.op}</span>
            {stat && <span className="text-xs text-slate-400">→ {stat.rowsAfter.toLocaleString()} rows</span>}
            {skipped && <span className="text-xs font-medium text-amber-600">skipped</span>}
          </div>
          <div className="truncate text-sm text-slate-600" title={describeOp(op)}>
            {describeOp(op)}
          </div>
          {(op.reason || stat?.note) && <div className="mt-0.5 text-xs text-slate-400">{[op.reason, stat?.note].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="flex shrink-0 items-center">
          <button className="btn-ghost p-1.5" disabled={index === 0} onClick={() => onMove(-1)} title="Move up">
            <ChevronUp className="h-4 w-4" />
          </button>
          <button className="btn-ghost p-1.5" disabled={index === count - 1} onClick={() => onMove(1)} title="Move down">
            <ChevronDown className="h-4 w-4" />
          </button>
          <button className={`btn-ghost p-1.5 ${open ? 'bg-slate-100' : ''}`} onClick={() => setOpen(!open)} title="Edit">
            <Pencil className="h-4 w-4" />
          </button>
          <button className="btn-ghost p-1.5" onClick={onDelete} title="Delete">
            <Trash2 className="h-4 w-4 text-red-500" />
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-3">
          <div>
            <label className="label">Step name (Applied Steps)</label>
            <input className="input" placeholder="auto" value={op.title ?? ''} onChange={(e) => onChange({ ...op, title: e.target.value || undefined })} />
          </div>
          {FIELDS[op.op]?.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.kind === 'column' && (
                <select className="input" value={String(o[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">— choose —</option>
                  {columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
              {f.kind === 'columns' && (
                <div className="flex flex-wrap gap-1.5">
                  {columns.map((c) => {
                    const list = (o[f.key] as string[] | undefined) ?? [];
                    const on = list.includes(c);
                    return (
                      <button
                        key={c}
                        className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600'}`}
                        onClick={() => set(f.key, on ? list.filter((x) => x !== c) : [...list, c])}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
              {f.kind === 'text' && <input className="input" value={String(o[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />}
              {f.kind === 'value' && (
                <input
                  className="input font-mono"
                  placeholder='text, number, or "null"'
                  value={o[f.key] === null ? 'null' : String(o[f.key] ?? '')}
                  onChange={(e) => set(f.key, parseValue(e.target.value))}
                />
              )}
              {f.kind === 'bool' && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={Boolean(o[f.key])} onChange={(e) => set(f.key, e.target.checked)} /> yes
                </label>
              )}
              {f.kind === 'type' && (
                <select className="input" value={String(o[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
              {f.kind === 'operator' && (
                <select className="input" value={String(o[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                  {OPERATORS.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
              {f.kind === 'list' && (
                <input
                  className="input"
                  value={((o[f.key] as string[]) ?? []).join(', ')}
                  onChange={(e) =>
                    set(
                      f.key,
                      e.target.value.split(',').map((s) => s.trim()),
                    )
                  }
                />
              )}
              {f.kind === 'json' && (
                <>
                  <textarea
                    className="input h-28 font-mono text-xs"
                    value={jsonText ?? JSON.stringify(o[f.key], null, 2)}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      try {
                        set(f.key, JSON.parse(e.target.value));
                      } catch {
                        /* wait until valid */
                      }
                    }}
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    kinds: arithmetic {'{left, operator, right}'} · datePart {'{column, part}'} (part: year, month, quarter, age…) · concat{' '}
                    {'{columns, separator}'} · conditional {'{column, operator, value, then, else}'} · bucket {'{column, bounds, labels}'} · custom{' '}
                    {'{mExpression, type}'}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
