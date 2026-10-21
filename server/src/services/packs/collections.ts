import type {
  Analysis,
  CleaningOp,
  FieldRef,
  MeasureSpec,
  ModelSpec,
  PageSpec,
  Project,
  ReportSpec,
  TableProfile,
  VisualSpec,
} from '../../../../shared/types.js';
import { daxColumn, daxMeasureRef, daxTable } from '../dax.js';
import { MEASURE_TABLE } from '../model.js';
import { DPD_RE, newId, op } from '../rules.js';
import { isIdLikeName } from '../values.js';

// Collections & Recovery pack: a standard banking analysis recognised from the
// data (loan performance with days-past-due + customer income + bureau data).
// It reproduces the usual collection-strategy workflow:
//   merge → DTI / outstanding % → SMA/NPA buckets → bureau & income risk →
//   delinquency trend → weighted risk score → priority → strategy & action →
//   working lists, portfolio & strategy summaries, executive dashboard.

export const MASTER = 'Collection Master';

const find = (p: TableProfile | undefined, re: RegExp, numeric = false) =>
  p?.columns.find((c) => re.test(c.name) && (!numeric || ['number', 'integer', 'currency'].includes(c.inferredType)))?.name;

export interface CollectionsPlan {
  loan: string;
  merges: { table: string; key: string }[];
  cols: {
    dpd: string;
    amount?: string;
    outstanding?: string;
    loanType?: string;
    loanId?: string;
    customerId?: string;
    customerName?: string;
    income?: string;
    debt?: string;
    score?: string;
    del6?: string;
    del12?: string;
    del24?: string;
    inquiries?: string;
    defaultFlag?: string;
  };
}

/** Recognise the pack from the profiles. Returns null when the data is not a lending/collections dataset. */
export function detectCollections(project: Project): CollectionsPlan | null {
  const profiles = project.profiles;
  const loanP = profiles.find((p) => find(p, DPD_RE, true) && find(p, /outstanding|balance|amount/i, true));
  if (!loanP) return null;
  const has = (p: TableProfile, c: string) => p.columns.some((x) => x.name === c);
  const unique = (p: TableProfile, c: string) => {
    const col = p.columns.find((x) => x.name === c);
    return Boolean(col && col.distinct === p.rowCount && col.nulls === 0);
  };

  const merges: CollectionsPlan['merges'] = [];
  for (const other of profiles) {
    if (other === loanP) continue;
    const shared = other.columns.map((c) => c.name).filter((c) => has(loanP, c) && isIdLikeName(c));
    if (!shared.length) continue;
    // Prefer a key that identifies one row in the other table (no row duplication).
    const key = shared.find((k) => unique(other, k) && /customer/i.test(k) && /bureau|score|credit/i.test(other.table)) ??
      shared.find((k) => unique(other, k) && /loan/i.test(k)) ??
      shared.find((k) => unique(other, k));
    if (key) merges.push({ table: other.table, key });
  }

  const all = [loanP, ...merges.map((m) => profiles.find((p) => p.table === m.table)!)];
  const pick = (re: RegExp, numeric = false) => {
    for (const p of all) {
      const c = find(p, re, numeric);
      if (c) return c;
    }
    return undefined;
  };
  return {
    loan: loanP.table,
    merges,
    cols: {
      dpd: find(loanP, DPD_RE, true)!,
      amount: find(loanP, /loan amount|sanction|disburs|principal|^amount/i, true),
      outstanding: find(loanP, /outstanding|balance/i, true),
      loanType: find(loanP, /loan type|product|type/i),
      loanId: find(loanP, /loan id/i),
      customerId: pick(/customer id|cust id|client id/i),
      customerName: pick(/customer name|name/i),
      income: pick(/monthly income|income/i, true),
      debt: pick(/monthly debt|emi|obligation|debt/i, true),
      score: pick(/\bscore\b|cibil/i, true),
      del6: pick(/(delinquen|dpd).*\b6\b/i, true),
      del12: pick(/(delinquen|dpd).*\b12\b/i, true),
      del24: pick(/(delinquen|dpd).*\b24\b/i, true),
      inquiries: pick(/inquir|enquir/i, true),
      defaultFlag: pick(/default/i, true),
    },
  };
}

/** True once the pack's derived columns exist in the cleaned loan table. */
export function collectionsReady(project: Project): CollectionsPlan | null {
  const plan = detectCollections(project);
  if (!plan) return null;
  const schema = project.cleanedSchemas[plan.loan] ?? [];
  return schema.some((c) => c.name === 'Collection Priority') && schema.some((c) => c.name === 'Collection Strategy') ? plan : null;
}

// ---------- Q1–Q5: merge + derived columns ----------

const DPD_BOUNDS = [0, 30, 60, 90, 180];

/** Pack steps per table: renames in merged tables + the full Q1–Q8 pipeline on the loan table. */
export function collectionsCleaning(project: Project, plan: CollectionsPlan): Record<string, CleaningOp[]> {
  const result: Record<string, CleaningOp[]> = {};
  // Merged columns must not collide with the pack's measure names (e.g. bureau "Total Outstanding").
  const reserved: Record<string, string> = { 'total outstanding': 'Bureau Exposure', 'total accounts': 'Bureau Total Accounts' };
  for (const m of plan.merges) {
    const prof = project.profiles.find((p) => p.table === m.table);
    for (const col of prof?.columns ?? []) {
      const to = reserved[col.name.toLowerCase()];
      if (to && col.name !== m.key) {
        (result[m.table] ??= []).push(op({ op: 'rename', from: col.name, to } as never, `"${col.name}" would clash with the ${col.name} measure`));
      }
    }
  }
  result[plan.loan] = loanSteps(plan);
  return result;
}

function loanSteps(plan: CollectionsPlan): CleaningOp[] {
  const c = plan.cols;
  const ops: CleaningOp[] = [];
  const add = (name: string, spec: unknown, reason: string) => ops.push(op({ op: 'addColumn', name, spec } as never, reason));

  // Q1 – one consolidated COLLECTION_MASTER
  for (const m of plan.merges) {
    ops.push(op({ op: 'mergeTable', table: m.table, leftKey: m.key, rightKey: m.key } as never, `Q1: bring ${m.table} into the collection master (join on ${m.key})`));
  }

  // Q2 – transformations
  if (c.debt && c.income) {
    add('DTI %', { kind: 'arithmetic', left: c.debt, operator: '/', right: c.income, scale: 100, round: 2 }, 'Q2: DTI % = Monthly Debt / Monthly Income × 100');
  }
  if (c.outstanding && c.amount) {
    add('Outstanding %', { kind: 'arithmetic', left: c.outstanding, operator: '/', right: c.amount, scale: 100, round: 2 }, 'Q2: Outstanding % = Loan Outstanding / Loan Amount × 100');
  }
  add(
    'DPD Bucket',
    { kind: 'bucket', column: c.dpd, bounds: DPD_BOUNDS, labels: ['Current', 'SMA-0', 'SMA-1', 'SMA-2', 'NPA', 'Severe NPA'] },
    'Q2: 0 Current · 1–30 SMA-0 · 31–60 SMA-1 · 61–90 SMA-2 · 91–180 NPA · >180 Severe NPA',
  );
  if (c.score) {
    add('Bureau Risk', { kind: 'bucket', column: c.score, bounds: [649, 699, 749], labels: ['Very High', 'High', 'Moderate', 'Low'] }, 'Q2: score ≥750 Low · 700–749 Moderate · 650–699 High · <650 Very High');
  }
  if (c.debt && c.income) {
    add('Income Risk', { kind: 'bucket', column: 'DTI %', bounds: [29.99, 50, 70], labels: ['Low', 'Moderate', 'High', 'Critical'] }, 'Q2: DTI <30 Low · 30–50 Moderate · 50–70 High · >70 Critical');
  }
  if (c.del6 || c.del12 || c.del24) {
    const cases = [
      c.del24 && { column: c.del24, operator: 'greaterOrEqual', value: 3, then: 'High' },
      c.del12 && { column: c.del12, operator: 'greaterOrEqual', value: 2, then: 'Moderate' },
      c.del6 && { column: c.del6, operator: 'greaterOrEqual', value: 1, then: 'Low' },
    ].filter(Boolean);
    add('Delinquency Trend', { kind: 'cases', cases, else: 'Clean' }, 'Q2: 3+ in 24M High · 2 in 12M Moderate · 1 in 6M Low · none Clean');
  }

  // Q4 – weighted collection risk score (0–100)
  const parts: string[] = [];
  const points = (name: string, column: string | undefined, bounds: number[], labels: number[], reason: string) => {
    if (!column) return;
    add(name, { kind: 'bucket', column, bounds, labels, numeric: true }, reason);
    parts.push(name);
  };
  points('DPD Score', c.dpd, [0, 30, 60, 90, 179], [0, 10, 15, 20, 30, 40], 'Q4: DPD points (max 40)');
  points('Bureau Score Points', c.score, [549, 649, 699, 749], [25, 15, 8, 4, 0], 'Q4: bureau score points (max 25)');
  points('Delinquency 6M Score', c.del6, [0, 1, 2], [0, 5, 10, 15], 'Q4: delinquencies in 6 months (max 15)');
  points('Inquiry Score', c.inquiries, [1, 3], [0, 5, 10], 'Q4: credit inquiries (max 10)');
  if (c.debt && c.income) points('DTI Score', 'DTI %', [19.99, 40, 60], [0, 4, 7, 10], 'Q4: DTI points (max 10)');
  add('Collection Risk Score', { kind: 'sum', columns: parts }, 'Q4: total collection risk score (0–100)');

  // Q5 – priority
  add('Risk Score Band', { kind: 'bucket', column: 'Collection Risk Score', bounds: [20, 40, 60], labels: ['0–20', '21–40', '41–60', '>60'] }, 'Q5: score bands');
  add(
    'Collection Priority',
    { kind: 'bucket', column: 'Collection Risk Score', bounds: [20, 40, 60], labels: ['Low', 'Medium', 'High', 'Critical'] },
    'Q5: 0–20 Low · 21–40 Medium · 41–60 High · >60 Critical',
  );

  // Q3 – strategy and action by DPD
  add(
    'Collection Strategy',
    { kind: 'bucket', column: c.dpd, bounds: DPD_BOUNDS, labels: ['Regular Monitoring', 'Early Collection', 'Soft Collection', 'Intensive Collection', 'Hard Collection', 'Recovery / Legal'] },
    'Q3: strategy by DPD',
  );
  add(
    'Recommended Action',
    {
      kind: 'bucket',
      column: c.dpd,
      bounds: DPD_BOUNDS,
      labels: ['Monitor account', 'SMS / WhatsApp / Email reminder', 'Tele-calling', 'Calling + Payment Plan', 'Field Collection', 'Settlement / Legal / Recovery'],
    },
    'Q3: action for each strategy',
  );
  if (c.defaultFlag) add('Default Status', { kind: 'bucket', column: c.defaultFlag, bounds: [0], labels: ['No', 'Yes'] }, 'Default flag as Yes/No');

  // Q7 / Q8 – selection flags used by the working-list pages
  const needs = [
    { column: c.dpd, operator: 'greaterThan', value: 0, then: 'Yes' },
    { column: 'Collection Risk Score', operator: 'greaterThan', value: 20, then: 'Yes' },
    ...(c.defaultFlag ? [{ column: c.defaultFlag, operator: 'equals', value: 1, then: 'Yes' }] : []),
  ];
  add('Needs Collection', { kind: 'cases', cases: needs, else: 'No' }, 'Q7: DPD > 0 OR priority Medium/High/Critical OR default');
  add(
    'Critical Account',
    {
      kind: 'cases',
      cases: [
        { column: 'Collection Priority', operator: 'equals', value: 'Critical', then: 'Yes' },
        { column: 'Collection Risk Score', operator: 'greaterThan', value: 60, then: 'Yes' },
        { column: c.dpd, operator: 'greaterThan', value: 90, then: 'Yes' },
      ],
      else: 'No',
    },
    'Q8: priority Critical OR risk score > 60 OR DPD > 90',
  );

  // Practical Q&A flags (sheet "Collection Recovery Q A") — each becomes a slicer on the Risk Explorer page.
  const flag = (name: string, cases: unknown[], elseValue: string, reason: string) => add(name, { kind: 'cases', cases, else: elseValue }, reason);
  flag('DPD 30+', [{ column: c.dpd, operator: 'greaterOrEqual', value: 30, then: 'Yes' }], 'No', 'Q&A 2/7/15: delinquent = DPD ≥ 30');
  flag(
    'High Risk',
    [{ column: c.dpd, operator: 'greaterOrEqual', value: 90, then: 'Yes' }, ...(c.defaultFlag ? [{ column: c.defaultFlag, operator: 'equals', value: 1, then: 'Yes' }] : [])],
    'No',
    'Q&A 9: DPD ≥ 90 OR default',
  );
  if (c.debt && c.income) flag('High DTI (>60%)', [{ column: 'DTI %', operator: 'greaterThan', value: 60, then: 'Yes' }], 'No', 'Q&A 10: DTI above 60%');
  if (c.del6) {
    // AND conditions written as "fail fast": any unmet condition → No.
    flag(
      'Repeat Delinquent',
      [
        { column: c.del6, operator: 'lessThan', value: 2, then: 'No' },
        { column: c.dpd, operator: 'lessThan', value: 30, then: 'No' },
      ],
      'Yes',
      'Q&A 12: 2+ delinquencies in 6 months AND DPD ≥ 30',
    );
  }
  if (c.inquiries && c.score && c.del6) {
    flag(
      'Stressed Borrower',
      [
        { column: c.inquiries, operator: 'lessThan', value: 3, then: 'No' },
        { column: c.score, operator: 'greaterOrEqual', value: 650, then: 'No' },
        { column: c.del6, operator: 'lessThan', value: 1, then: 'No' },
      ],
      'Yes',
      'Q&A 17: 3+ inquiries AND score < 650 AND recent delinquency',
    );
  }
  ops.push(op({ op: 'addRank', name: 'Risk Rank', column: 'Collection Risk Score', descending: true } as never, 'Q&A 20: rank accounts by collection risk score'));
  return ops;
}

// ---------- model ----------

export function collectionsModel(project: Project, plan: CollectionsPlan): ModelSpec {
  const schema = project.cleanedSchemas[plan.loan] ?? [];
  const date = schema.find((c) => (c.type === 'date' || c.type === 'datetime') && /open|disburs|start|sanction/i.test(c.name));
  return {
    tables: [{ name: MASTER, role: 'fact', source: plan.loan, columns: schema.map((c) => c.name) }],
    relationships: [],
    dateTable: date ? { enabled: true, name: 'Date', table: MASTER, column: date.name } : { enabled: false, name: 'Date', table: '', column: '' },
    source: 'rules',
  };
}

// ---------- measures ----------

export function collectionsMeasures(project: Project, plan: CollectionsPlan): MeasureSpec[] {
  const schema = new Set((project.cleanedSchemas[plan.loan] ?? []).map((c) => c.name));
  const c = plan.cols;
  const T = daxTable(MASTER);
  const col = (n: string) => daxColumn(MASTER, n);
  const m: MeasureSpec[] = [];
  const add = (name: string, expression: string, formatString: string, displayFolder: string, description: string) =>
    m.push({ name, expression, formatString, displayFolder, description });
  const cr = (measure: string) => `DIVIDE(${daxMeasureRef(measure)}, 10000000)`;

  add('Total Accounts', `COUNTROWS(${T})`, '#,0', 'Portfolio', 'Number of loan accounts');
  if (c.amount) add('Total Loan Amount', `SUM(${col(c.amount)})`, '#,0', 'Portfolio', 'Original loan amount');
  if (c.outstanding) {
    add('Total Outstanding', `SUM(${col(c.outstanding)})`, '#,0', 'Portfolio', 'Current outstanding balance');
    add('Total Outstanding (Cr)', cr('Total Outstanding'), '#,0.0', 'Portfolio', 'Outstanding in ₹ crore');
  }
  add('Average DPD', `AVERAGE(${col(c.dpd)})`, '0.0', 'Portfolio', 'Average days past due');
  if (schema.has('DTI %')) add('Average DTI %', `AVERAGE(${col('DTI %')})`, '0.0', 'Portfolio', 'Average debt-to-income ratio (%)');
  if (schema.has('Outstanding %')) add('Average Outstanding %', `AVERAGE(${col('Outstanding %')})`, '0.0', 'Portfolio', 'Average outstanding as % of the loan amount');
  if (c.score) add('Average Bureau Score', `AVERAGE(${col(c.score)})`, '0', 'Portfolio', 'Average credit bureau score');
  add('Average Risk Score', `AVERAGE(${col('Collection Risk Score')})`, '0.0', 'Risk', 'Average collection risk score (0–100)');

  add('Accounts in Collection', `CALCULATE(COUNTROWS(${T}), ${col('Needs Collection')} = "Yes")`, '#,0', 'Collections', 'Accounts that need collection (Q7)');
  add('% Accounts in Collection', `DIVIDE([Accounts in Collection], [Total Accounts])`, '0.0%', 'Collections', 'Share of accounts that need collection');
  add('Critical Accounts', `CALCULATE(COUNTROWS(${T}), ${col('Critical Account')} = "Yes")`, '#,0', 'Collections', 'Accounts for immediate action (Q8)');
  add('% Critical Accounts', `DIVIDE([Critical Accounts], [Total Accounts])`, '0.0%', 'Collections', 'Share of accounts that are critical');
  add('Delinquent Accounts', `CALCULATE(COUNTROWS(${T}), ${col(c.dpd)} > 0)`, '#,0', 'Collections', 'Accounts with DPD above 0');
  add('Delinquency %', `DIVIDE([Delinquent Accounts], [Total Accounts])`, '0.0%', 'Collections', 'Share of accounts past due');
  add('NPA Accounts', `CALCULATE(COUNTROWS(${T}), ${col(c.dpd)} > 90)`, '#,0', 'Collections', 'Non-performing: more than 90 days past due');
  add('NPA %', `DIVIDE([NPA Accounts], [Total Accounts])`, '0.0%', 'Collections', 'Share of accounts that are NPA');
  if (c.outstanding) {
    add('Overdue Outstanding', `CALCULATE(SUM(${col(c.outstanding)}), ${col(c.dpd)} > 0)`, '#,0', 'Collections', 'Outstanding on past-due accounts');
    add('Overdue Outstanding %', `DIVIDE([Overdue Outstanding], [Total Outstanding])`, '0.0%', 'Collections', 'Share of the outstanding that is past due');
    add('NPA Outstanding (Cr)', `DIVIDE(CALCULATE(SUM(${col(c.outstanding)}), ${col(c.dpd)} > 90), 10000000)`, '#,0.0', 'Collections', 'Outstanding on NPA accounts, ₹ crore');
  }
  if (c.defaultFlag) {
    add('Default Accounts', `SUM(${col(c.defaultFlag)})`, '#,0', 'Risk', 'Accounts with a past default');
    add('Default Rate', `AVERAGE(${col(c.defaultFlag)})`, '0.0%', 'Risk', 'Share of accounts with a past default');
  }
  add('Delinquent Accounts (30+ DPD)', `CALCULATE(COUNTROWS(${T}), ${col(c.dpd)} >= 30)`, '#,0', 'Collections', 'Accounts with DPD of 30 or more');
  add('Delinquency Rate (30+ DPD)', `DIVIDE([Delinquent Accounts (30+ DPD)], [Total Accounts])`, '0.0%', 'Collections', 'Q&A 15: DPD ≥ 30 accounts / total accounts');
  if (c.outstanding) {
    add('Delinquent Outstanding (30+ DPD)', `CALCULATE(SUM(${col(c.outstanding)}), ${col(c.dpd)} >= 30)`, '#,0', 'Collections', 'Q&A 7: outstanding on DPD ≥ 30 accounts');
  }
  if (schema.has('High Risk')) add('High Risk Accounts', `CALCULATE(COUNTROWS(${T}), ${col('High Risk')} = "Yes")`, '#,0', 'Risk', 'Q&A 9: DPD ≥ 90 or default');
  if (schema.has('Stressed Borrower')) add('Stressed Borrowers', `CALCULATE(COUNTROWS(${T}), ${col('Stressed Borrower')} = "Yes")`, '#,0', 'Risk', 'Q&A 17: many inquiries, low score and delinquency');
  add('% of Accounts', `DIVIDE([Total Accounts], CALCULATE([Total Accounts], ALLSELECTED(${T})))`, '0.0%', 'Summary', 'Share of all accounts in the current selection');
  if (c.outstanding) {
    add('% of Outstanding', `DIVIDE([Total Outstanding], CALCULATE([Total Outstanding], ALLSELECTED(${T})))`, '0.0%', 'Summary', 'Share of the total outstanding');
  }
  return m;
}

// ---------- Q6–Q10 + executive dashboard ----------

const measure = (name: string): FieldRef => ({ kind: 'measure', table: MEASURE_TABLE, name });
const column = (name: string): FieldRef => ({ kind: 'column', table: MASTER, name });

export function collectionsReport(project: Project, plan: CollectionsPlan, measures: MeasureSpec[]): ReportSpec {
  const have = new Set(measures.map((x) => x.name));
  const schema = new Set((project.cleanedSchemas[plan.loan] ?? []).map((c) => c.name));
  const c = plan.cols;
  const V = (type: VisualSpec['type'], title: string, fields: VisualSpec['fields'], extra: Partial<VisualSpec> = {}): VisualSpec => ({
    id: newId(),
    type,
    title,
    fields: fields.filter((f) => (f.field.kind === 'measure' ? have.has(f.field.name) : schema.has(f.field.name))),
    ...extra,
  });
  const card = (name: string, title = name) => V('card', title, [{ role: 'Values', field: measure(name) }]);
  const by = (type: VisualSpec['type'], title: string, cat: string, value: string, extra: Partial<VisualSpec> = {}) =>
    V(type, title, [{ role: 'Category', field: column(cat) }, { role: 'Y', field: measure(value) }], extra);
  const slicer = (name: string) => V('slicer', name, [{ role: 'Values', field: column(name) }]);
  const cols = (names: (string | undefined)[]) => names.filter((n): n is string => Boolean(n && schema.has(n)));

  const workingList = cols([
    c.customerId,
    c.customerName,
    c.loanId,
    c.loanType,
    c.outstanding,
    c.dpd,
    'DTI %',
    c.score,
    c.del6,
    'Collection Risk Score',
    'Collection Priority',
    'Collection Strategy',
    'Recommended Action',
  ]);
  const listTable = (title: string) =>
    V('tableEx', title, workingList.map((n) => ({ role: 'Values', field: column(n) })), { sortField: column('Collection Risk Score'), sortDescending: true });
  const outstandingCr = have.has('Total Outstanding (Cr)') ? 'Total Outstanding (Cr)' : 'Total Accounts';

  const pages: PageSpec[] = [
    {
      id: newId(),
      name: 'Executive Overview',
      subtitle: 'Collection and recovery dashboard — executive overview',
      visuals: [
        card('Total Accounts'),
        card(outstandingCr, 'Total Outstanding (₹ Cr)'),
        card('Accounts in Collection'),
        card('% Accounts in Collection'),
        card('Average DPD'),
        card('Critical Accounts'),
        by('donutChart', 'Accounts by Collection Priority', 'Collection Priority', 'Total Accounts'),
        by('clusteredColumnChart', 'Outstanding Amount by Loan Type (₹ Cr)', c.loanType ?? 'DPD Bucket', outstandingCr, { sortDescending: true }),
        by('clusteredColumnChart', 'Accounts by DPD Bucket', 'DPD Bucket', 'Total Accounts'),
        by('donutChart', 'Accounts by Risk Score', 'Risk Score Band', 'Total Accounts'),
        by('donutChart', 'Collection Strategy Mix (accounts in collection)', 'Collection Strategy', 'Accounts in Collection'),
        by('clusteredColumnChart', 'Delinquency % by Bureau Risk', schema.has('Bureau Risk') ? 'Bureau Risk' : 'DPD Bucket', 'Delinquency %'),
        ...cols([c.loanType, 'Collection Priority', 'DPD Bucket']).map(slicer),
      ],
    },
    {
      id: newId(),
      name: 'Collection Working List',
      subtitle: 'Q6 — final working list for the collection team (sorted by risk score)',
      visuals: [...cols(['Collection Priority', 'Collection Strategy', c.loanType]).map(slicer), listTable('Final Collection Output')],
    },
    {
      id: newId(),
      name: 'Accounts for Collection',
      subtitle: 'Q7 — DPD > 0, or priority Medium / High / Critical, or past default',
      filters: [{ table: MASTER, column: 'Needs Collection', values: ['Yes'] }],
      visuals: [
        card('Total Accounts', 'Total Accounts for Collection'),
        card(outstandingCr, 'Outstanding (₹ Cr)'),
        by('donutChart', 'Priority Mix', 'Collection Priority', 'Total Accounts'),
        listTable('Accounts for Collection'),
      ],
    },
    {
      id: newId(),
      name: 'Critical Accounts',
      subtitle: 'Q8 — priority Critical, or risk score > 60, or DPD > 90: immediate action',
      filters: [{ table: MASTER, column: 'Critical Account', values: ['Yes'] }],
      visuals: [
        card('Total Accounts', 'Total Critical Accounts'),
        card(outstandingCr, 'Outstanding at Risk (₹ Cr)'),
        card('Average DPD'),
        by('clusteredBarChart', 'Critical Accounts by Strategy', 'Collection Strategy', 'Total Accounts', { sortDescending: true }),
        listTable('Critical Accounts'),
      ],
    },
    {
      id: newId(),
      name: 'Risk Explorer',
      subtitle: 'Practical Q&A — combine the flags on the left (DPD 30+, high risk, DTI > 60%, repeat delinquent, stressed borrower) to answer each question',
      visuals: [
        ...cols(['DPD 30+', 'High Risk', 'High DTI (>60%)', 'Repeat Delinquent', 'Stressed Borrower', 'Bureau Risk', c.loanType]).map(slicer),
        card('Total Accounts'),
        card(outstandingCr, 'Outstanding (₹ Cr)'),
        card('Delinquency Rate (30+ DPD)'),
        card('Average Bureau Score'),
        V(
          'tableEx',
          'Accounts (ranked by collection risk)',
          cols(['Risk Rank', c.loanId, c.customerName, c.loanType, c.outstanding, c.dpd, c.income, c.debt, 'DTI %', c.score, c.del6, c.inquiries, c.defaultFlag, 'Collection Priority']).map((n) => ({
            role: 'Values',
            field: column(n),
          })),
          { sortField: column('Risk Rank'), sortDescending: false },
        ),
      ],
    },
    {
      id: newId(),
      name: 'Top Exposure (30+ DPD)',
      subtitle: 'Q&A 14/16 — delinquent accounts sorted by outstanding; pick a loan type to see its top accounts',
      filters: [{ table: MASTER, column: 'DPD 30+', values: ['Yes'] }],
      visuals: [
        ...cols([c.loanType, 'DPD Bucket']).map(slicer),
        card('Total Accounts', 'Delinquent Accounts (30+ DPD)'),
        card(outstandingCr, 'Delinquent Outstanding (₹ Cr)'),
        by('clusteredBarChart', 'Delinquent Outstanding by Loan Type (₹ Cr)', c.loanType ?? 'DPD Bucket', outstandingCr, { sortDescending: true }),
        V(
          'tableEx',
          'Top accounts by outstanding',
          cols([c.loanType, c.customerName, c.loanId, c.outstanding, c.dpd, c.score, 'Collection Priority', 'Recommended Action']).map((n) => ({ role: 'Values', field: column(n) })),
          { sortField: column(c.outstanding ?? c.dpd), sortDescending: true },
        ),
      ],
    },
    {
      id: newId(),
      name: 'Portfolio Summary',
      subtitle: 'Q9 — overall view of the collection portfolio for management',
      visuals: [
        card('Total Accounts'),
        card(outstandingCr, 'Total Outstanding (₹ Cr)'),
        card('Accounts in Collection'),
        card('Average DPD'),
        card('Average DTI %'),
        by('clusteredColumnChart', 'Accounts by DPD Bucket', 'DPD Bucket', 'Total Accounts'),
        by('donutChart', 'Accounts by Collection Priority', 'Collection Priority', 'Total Accounts'),
        by('clusteredColumnChart', 'Outstanding by Loan Type (₹ Cr)', c.loanType ?? 'DPD Bucket', outstandingCr, { sortDescending: true }),
        V('pivotTable', 'Portfolio Summary by Loan Type', [
          { role: 'Rows', field: column(c.loanType ?? 'DPD Bucket') },
          ...[
            'Total Accounts',
            'Accounts in Collection',
            outstandingCr,
            'Delinquent Accounts (30+ DPD)',
            'NPA Accounts',
            'Default Accounts',
            'Average DPD',
            'Average DTI %',
            'Average Bureau Score',
          ].map((n) => ({ role: 'Values', field: measure(n) })),
        ]),
      ],
    },
    {
      id: newId(),
      name: 'Strategy Summary',
      subtitle: 'Q10 — strategy-level workload and exposure',
      visuals: [
        by('donutChart', 'Outstanding by Strategy (₹ Cr)', 'Collection Strategy', outstandingCr),
        by('clusteredColumnChart', 'Strategy-wise Workload (No. of Accounts)', 'Collection Strategy', 'Total Accounts'),
        V('pivotTable', 'Collection Strategy Summary', [
          { role: 'Rows', field: column('Collection Strategy') },
          ...['Total Accounts', '% of Accounts', outstandingCr, '% of Outstanding', 'Average DPD', 'Average DTI %'].map((n) => ({ role: 'Values', field: measure(n) })),
        ]),
      ],
    },
  ];

  return {
    title: 'Collection and Recovery Dashboard',
    subtitle: 'Executive overview',
    pages: pages.map((p) => ({ ...p, visuals: p.visuals.filter((v) => v.fields.length) })),
    theme: {
      name: 'Collections Navy & Orange',
      dataColors: ['#1F3A93', '#F26B21', '#2E9E4F', '#F4B400', '#D93025', '#7B2CBF', '#00A3E0', '#8D6E63'],
      background: '#FFFFFF',
      foreground: '#1F2937',
      tableAccent: '#1F3A93',
    },
    source: 'rules',
  };
}

export function collectionsAnalysis(project: Project, plan: CollectionsPlan): Analysis {
  const sizes = project.profiles.map((p) => `${p.table} (${p.rowCount.toLocaleString()} rows)`).join(', ');
  return {
    businessSummary:
      `A retail lending portfolio for collection and recovery planning: ${sizes}. ` +
      `${plan.loan} holds each loan's amount, outstanding balance and days past due (DPD); ` +
      `${plan.merges.map((m) => m.table).join(' and ') || 'the other tables'} add the customer's income, debt and credit-bureau history. ` +
      'The goal is to see which accounts need collection, how risky they are, and which strategy and action each should get, so the collection team works the right accounts first and NPAs fall.',
    businessQuestions: [
      'How big is the portfolio and how much is outstanding?',
      'How many accounts need collection, and how many are critical?',
      'How are accounts spread across DPD buckets (SMA-0/1/2, NPA)?',
      'Which customers are risky by bureau score, DTI and delinquency history?',
      'Which collection strategy and action should each account get?',
      'Where is the exposure by loan type and by strategy?',
    ],
    kpis: [
      { name: 'Total Accounts', definition: 'Number of loan accounts', formulaHint: 'COUNTROWS' },
      { name: 'Total Outstanding', definition: 'Current outstanding balance (₹ Cr)', formulaHint: `SUM(${plan.cols.outstanding ?? 'Outstanding'})` },
      { name: 'Accounts in Collection', definition: 'DPD > 0 or priority Medium+ or past default', formulaHint: 'COUNTROWS where Needs Collection = Yes' },
      { name: 'Critical Accounts', definition: 'Priority Critical or risk score > 60 or DPD > 90', formulaHint: 'COUNTROWS where Critical Account = Yes' },
      { name: 'Average DPD', definition: 'Average days past due', formulaHint: `AVERAGE(${plan.cols.dpd})` },
      { name: 'Average DTI %', definition: 'Monthly debt / monthly income × 100', formulaHint: 'AVERAGE(DTI %)' },
      { name: 'Delinquency % / NPA %', definition: 'Share of accounts with DPD > 0 / DPD > 90', formulaHint: 'DIVIDE' },
      { name: 'Collection Risk Score', definition: 'DPD 40 + bureau 25 + delinquency 15 + inquiries 10 + DTI 10 = 0–100', formulaHint: 'sum of score points' },
    ],
    dataIssues: project.profiles.flatMap((p) => p.columns.flatMap((col) => col.issues.map((i) => `${p.table}[${col.name}]: ${i}`))).slice(0, 30),
    dashboardIdea:
      'Executive overview (KPIs, priority, DPD buckets, loan type, risk score, strategy mix) plus working-list pages (all accounts, accounts for collection, critical accounts) and portfolio / strategy summaries.',
    source: 'rules',
  };
}
