import { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Calendar, Key, Sigma, Table2 } from 'lucide-react';
import type { CleanedColumn, ModelSpec } from '@shared/types';

type TableNodeData = { name: string; role: 'fact' | 'dimension' | 'date' | 'measures'; columns: CleanedColumn[]; keys: Set<string> };

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const head = {
    fact: 'bg-brand-600 text-white',
    dimension: 'bg-emerald-600 text-white',
    date: 'bg-violet-600 text-white',
    measures: 'bg-amber-500 text-white',
  }[data.role];
  const Icon = data.role === 'date' ? Calendar : data.role === 'measures' ? Sigma : Table2;
  return (
    <div className="w-56 overflow-hidden rounded-lg border border-slate-200 bg-white text-xs shadow-md">
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
      <div className={`flex items-center gap-1.5 px-3 py-2 font-semibold ${head}`}>
        <Icon className="h-3.5 w-3.5" /> <span className="truncate">{data.name}</span>
        <span className="ml-auto text-[10px] font-normal uppercase opacity-80">{data.role}</span>
      </div>
      <ul className="max-h-48 overflow-y-auto py-1">
        {data.columns.slice(0, 14).map((c) => (
          <li key={c.name} className="flex items-center gap-1.5 px-3 py-0.5 text-slate-600">
            {data.keys.has(c.name) ? <Key className="h-3 w-3 text-amber-500" /> : <span className="w-3" />}
            <span className="truncate">{c.name}</span>
            <span className="ml-auto text-[10px] text-slate-400">{c.type}</span>
          </li>
        ))}
        {data.columns.length > 14 && <li className="px-3 py-0.5 text-slate-400">+{data.columns.length - 14} more</li>}
      </ul>
    </div>
  );
}

const nodeTypes = { table: TableNode };

const DATE_COLUMNS: CleanedColumn[] = ['Date', 'Year', 'Quarter', 'Month Number', 'Month', 'Year Month', 'Day of Week'].map((name) => ({
  name,
  type: name === 'Date' ? 'date' : /Number|Year$/.test(name) ? 'integer' : 'text',
}));

export function SchemaCanvas({ model, schemas, measureCount }: { model: ModelSpec; schemas: Record<string, CleanedColumn[]>; measureCount: number }) {
  const { nodes, edges } = useMemo(() => {
    const keys = new Map<string, Set<string>>();
    const addKey = (t: string, c: string) => keys.set(t, (keys.get(t) ?? new Set()).add(c));
    for (const r of model.relationships) {
      addKey(r.fromTable, r.fromColumn);
      addKey(r.toTable, r.toColumn);
    }
    const facts = model.tables.filter((t) => t.role === 'fact');
    const dims = model.tables.filter((t) => t.role === 'dimension');
    const nodes: Node<TableNodeData>[] = [];
    const colsOf = (t: (typeof model.tables)[number]) =>
      t.columns.map((c) => schemas[t.source]?.find((s) => s.name === c) ?? { name: c, type: 'text' as const });

    facts.forEach((t, i) => nodes.push({ id: t.name, type: 'table', position: { x: 380, y: 40 + i * 320 }, data: { name: t.name, role: 'fact', columns: colsOf(t), keys: keys.get(t.name) ?? new Set() } }));
    const right = [...dims];
    if (model.dateTable.enabled) right.unshift({ name: model.dateTable.name, role: 'dimension', source: '', columns: [] });
    right.forEach((t, i) => {
      const isDate = model.dateTable.enabled && t.name === model.dateTable.name && !t.source;
      const side = i % 2 === 0 ? 760 : 0;
      nodes.push({
        id: t.name,
        type: 'table',
        position: { x: side, y: 20 + Math.floor(i / 2) * 270 },
        data: { name: t.name, role: isDate ? 'date' : 'dimension', columns: isDate ? DATE_COLUMNS : colsOf(t), keys: keys.get(t.name) ?? new Set() },
      });
    });
    nodes.push({
      id: '_Measures',
      type: 'table',
      position: { x: 380, y: 40 + Math.max(facts.length, 1) * 320 },
      data: { name: '_Measures', role: 'measures', columns: [{ name: `${measureCount} measures`, type: 'number' }], keys: new Set() },
    });

    const edges: Edge[] = model.relationships.map((r, i) => {
      const fromNode = nodes.find((n) => n.id === r.fromTable);
      const toNode = nodes.find((n) => n.id === r.toTable);
      const leftToRight = (fromNode?.position.x ?? 0) <= (toNode?.position.x ?? 0);
      return {
        id: `r${i}`,
        source: leftToRight ? r.fromTable : r.toTable,
        target: leftToRight ? r.toTable : r.fromTable,
        label: `${r.fromColumn} *:1`,
        animated: r.active === false,
        style: { strokeDasharray: r.active === false ? '4 4' : undefined, stroke: '#64748b' },
        labelStyle: { fontSize: 10, fill: '#475569' },
        markerEnd: leftToRight ? { type: MarkerType.ArrowClosed } : undefined,
        markerStart: leftToRight ? undefined : { type: MarkerType.ArrowClosed },
      };
    });
    return { nodes, edges };
  }, [model, schemas, measureCount]);

  return (
    <div className="card h-[560px] overflow-hidden">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }} nodesConnectable={false}>
        <Background gap={20} color="#e2e8f0" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
