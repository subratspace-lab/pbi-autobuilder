// End-to-end smoke test against a running server (npm run dev / npm start).
// Usage: node scripts/e2e.mjs [ai|rules]   (default: rules — no API key needed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'rules';
const base = process.env.API ?? 'http://localhost:3000/api';
const samples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body instanceof FormData || !body ? undefined : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${json.error}`);
  return json;
}

const step = (s) => console.log(`\n== ${s}`);

let p = await call('POST', '/projects', { name: `Superstore Sales (${mode})` });
step(`Project ${p.id}`);

const form = new FormData();
form.append('files', new Blob([fs.readFileSync(path.join(samples, 'superstore_messy.csv'))]), 'superstore_messy.csv');
form.append('files', new Blob([fs.readFileSync(path.join(samples, 'project_brief.md'))]), 'project_brief.md');
const up = await call('POST', `/projects/${p.id}/files`, form);
console.log('tables:', up.project.tables.map((t) => `${t.name} (${t.rowCount})`), 'brief chars:', up.project.brief.text.length, up.warnings);

step('Profile');
p = await call('POST', `/projects/${p.id}/profile`);
for (const c of p.profiles[0].columns) if (c.issues.length) console.log(`  ${c.name} [${c.inferredType}]: ${c.issues.join('; ')}`);

step('Analyze');
p = await call('POST', `/projects/${p.id}/analyze`, { mode });
console.log(p.analysis.businessSummary.slice(0, 300));

step('Cleaning');
const cl = await call('POST', `/projects/${p.id}/cleaning/suggest`, { mode });
const t = cl.project.tables[0].name;
const view = await call('GET', `/projects/${p.id}/cleaning/${encodeURIComponent(t)}`);
console.log(`${view.result.rowsBefore} -> ${view.result.rowsAfter} rows`);
for (const s of view.result.stepStats) console.log(`  ${s.title}${s.note ? ` — ${s.note}` : ''}`);
console.log('warnings:', [...cl.warnings, ...view.result.warnings]);

step('Model');
const md = await call('POST', `/projects/${p.id}/model/suggest`, { mode });
for (const mt of md.project.model.tables) console.log(`  ${mt.name} (${mt.role}) ${mt.columns.length} cols${mt.key ? ` key=${mt.key}` : ''}`);
for (const r of md.project.model.relationships) console.log(`  ${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}]`);
console.log('issues:', md.issues);

step('Measures');
const ms = await call('POST', `/projects/${p.id}/measures/suggest`, { mode });
const check = await call('GET', `/projects/${p.id}/measures/check`);
for (const m of ms.project.measures) {
  const v = check.values.find((x) => x.name === m.name)?.value;
  console.log(`  ${m.name} = ${m.expression.replace(/\n/g, ' ')}  ->  ${v ?? '(Power BI only)'}`);
}
console.log('lint:', ms.lint);

step('Report');
const rp = await call('POST', `/projects/${p.id}/report/suggest`, { mode });
for (const v of rp.project.report.visuals) console.log(`  ${v.type}: ${v.title}`);
const prev = await call('GET', `/projects/${p.id}/report/preview`);
console.log('page', prev.layout.width, 'x', prev.layout.height, 'previewed visuals:', Object.keys(prev.data.visuals).length);

step('Export');
const ex = await call('POST', `/projects/${p.id}/export`);
console.log(ex.projectFile, '\nrows:', ex.rowChecks, '\nwarnings:', ex.warnings);
