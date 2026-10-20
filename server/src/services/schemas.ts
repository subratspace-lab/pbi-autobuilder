import { z } from 'zod';

// zod schemas for everything the AI returns. Kept lenient where harmless
// (defaults, coercion) and strict where a mistake would break Power BI.

const columnType = z.enum(['text', 'number', 'integer', 'currency', 'date', 'datetime', 'boolean']);
const filterOperator = z.enum([
  'equals',
  'notEquals',
  'greaterThan',
  'lessThan',
  'greaterOrEqual',
  'lessOrEqual',
  'contains',
  'notContains',
  'isNotBlank',
]);
const scalar = z.union([z.string(), z.number()]);

export const analysisSchema = z.object({
  businessSummary: z.string(),
  businessQuestions: z.array(z.string()).default([]),
  kpis: z
    .array(z.object({ name: z.string(), definition: z.string().default(''), formulaHint: z.string().default('') }))
    .default([]),
  dataIssues: z.array(z.string()).default([]),
  dashboardIdea: z.string().default(''),
});

const addColumnSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('arithmetic'), left: z.string(), operator: z.enum(['+', '-', '*', '/']), right: scalar }),
  z.object({
    kind: z.literal('datePart'),
    column: z.string(),
    part: z.enum(['year', 'month', 'monthName', 'quarter', 'day', 'weekdayName', 'age']),
  }),
  z.object({ kind: z.literal('bucket'), column: z.string(), bounds: z.array(z.number()).min(1), labels: z.array(z.coerce.string()).min(2) }),
  z.object({ kind: z.literal('concat'), columns: z.array(z.string()).min(1), separator: z.string().default(' ') }),
  z.object({
    kind: z.literal('conditional'),
    column: z.string(),
    operator: filterOperator,
    value: scalar,
    then: z.coerce.string(),
    else: z.coerce.string(),
  }),
  z.object({ kind: z.literal('custom'), mExpression: z.string(), type: columnType.default('text') }),
]);

const base = { title: z.string().optional(), reason: z.string().optional() };
const cols = z.array(z.string()).min(1);

export const cleaningOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setType'), column: z.string(), type: columnType, ...base }),
  z.object({ op: z.literal('trim'), columns: cols, ...base }),
  z.object({ op: z.literal('clean'), columns: cols, ...base }),
  z.object({ op: z.literal('properCase'), columns: cols, ...base }),
  z.object({ op: z.literal('upperCase'), columns: cols, ...base }),
  z.object({ op: z.literal('lowerCase'), columns: cols, ...base }),
  z.object({ op: z.literal('emptyToNull'), columns: cols, ...base }),
  z.object({
    op: z.literal('replaceValues'),
    column: z.string(),
    find: scalar.nullable(),
    replace: scalar.nullable(),
    wholeValue: z.boolean().default(true),
    ...base,
  }),
  z.object({ op: z.literal('replaceNulls'), column: z.string(), value: scalar, ...base }),
  z.object({ op: z.literal('removeDuplicates'), columns: z.array(z.string()).optional(), ...base }),
  z.object({ op: z.literal('removeBlankRows'), ...base }),
  z.object({ op: z.literal('removeRowsWithBlank'), column: z.string(), ...base }),
  z.object({ op: z.literal('fillDown'), columns: cols, ...base }),
  z.object({
    op: z.literal('splitColumn'),
    column: z.string(),
    delimiter: z.string().min(1),
    newColumns: z.array(z.string()).min(2),
    ...base,
  }),
  z.object({ op: z.literal('addColumn'), name: z.string(), spec: addColumnSpec, ...base }),
  z.object({ op: z.literal('rename'), from: z.string(), to: z.string(), ...base }),
  z.object({ op: z.literal('removeColumns'), columns: cols, ...base }),
  z.object({ op: z.literal('filterRows'), column: z.string(), operator: filterOperator, value: scalar.optional(), ...base }),
]);

/** Ops are validated one by one so a single bad op does not discard the rest. */
export const cleaningSuggestionSchema = z.object({
  tables: z.array(z.object({ table: z.string(), ops: z.array(z.unknown()) })),
});

export const modelSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      role: z.enum(['fact', 'dimension']),
      source: z.string(),
      columns: z.array(z.string()).min(1),
      key: z.string().optional().nullable(),
    }),
  ),
  relationships: z
    .array(z.object({ fromTable: z.string(), fromColumn: z.string(), toTable: z.string(), toColumn: z.string() }))
    .default([]),
  dateTable: z.object({ table: z.string(), column: z.string() }).optional().nullable(),
});

export const measuresSchema = z.object({
  measures: z.array(
    z.object({
      name: z.string(),
      expression: z.string(),
      formatString: z.string().default('#,0'),
      displayFolder: z.string().default(''),
      description: z.string().default(''),
    }),
  ),
});

const fieldRef = z.object({ kind: z.enum(['measure', 'column']), table: z.string(), name: z.string() });

export const reportSchema = z.object({
  title: z.string(),
  subtitle: z.string().default(''),
  visuals: z.array(
    z.object({
      type: z.enum([
        'card',
        'multiRowCard',
        'lineChart',
        'clusteredBarChart',
        'clusteredColumnChart',
        'donutChart',
        'pivotTable',
        'tableEx',
        'map',
        'slicer',
      ]),
      title: z.string(),
      fields: z.array(z.object({ role: z.string(), field: fieldRef })),
      sortDescending: z.boolean().optional(),
    }),
  ),
  theme: z
    .object({
      name: z.string(),
      dataColors: z.array(z.string()).min(3),
      background: z.string(),
      foreground: z.string(),
      tableAccent: z.string(),
    })
    .optional(),
});
