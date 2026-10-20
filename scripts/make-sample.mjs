// Generates a deliberately messy retail dataset + project brief for demos/tests.
// Usage: node scripts/make-sample.mjs   -> samples/superstore_messy.csv, samples/project_brief.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
fs.mkdirSync(out, { recursive: true });

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const regions = { East: ['New York', 'Boston', 'Philadelphia'], West: ['Los Angeles', 'Seattle', 'San Francisco'], Central: ['Chicago', 'Houston', 'Dallas'], South: ['Atlanta', 'Miami', 'Nashville'] };
const catalog = {
  Furniture: { Chairs: ['Ergo Chair', 'Task Chair'], Tables: ['Oak Table', 'Glass Desk'], Bookcases: ['5-Shelf Bookcase'] },
  'Office Supplies': { Paper: ['Copy Paper', 'Notebook Pack'], Binders: ['Ring Binder', 'Presentation Binder'], Storage: ['File Box', 'Desk Organizer'] },
  Technology: { Phones: ['Smartphone X', 'Office Phone'], Accessories: ['Wireless Mouse', 'USB Hub'], Machines: ['Laser Printer'] },
};
const basePrice = { Chairs: 180, Tables: 420, Bookcases: 260, Paper: 18, Binders: 12, Storage: 35, Phones: 520, Accessories: 30, Machines: 900 };
const segments = ['Consumer', 'Corporate', 'Home Office'];
const first = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Drew', 'Parker'];
const last = ['Smith', 'Lee', 'Patel', 'Garcia', 'Brown', 'Khan', 'Nguyen', 'Miller', 'Lopez', 'Wilson'];

const customers = Array.from({ length: 120 }, (_, i) => ({
  id: `CUST-${String(i + 1).padStart(4, '0')}`,
  name: `${pick(first)} ${pick(last)}`,
  segment: pick(segments),
}));

const header = ['Order ID', 'Order Date', 'Ship Mode', 'Customer ID', 'Customer Name', 'Segment', 'Region', 'City', 'Category', 'Sub-Category', 'Product Name', 'Sales', 'Quantity', 'Discount', 'Profit'];
const rows = [];
const start = Date.UTC(2023, 0, 1);
for (let i = 0; i < 1800; i++) {
  const c = pick(customers);
  const region = pick(Object.keys(regions));
  const cat = pick(Object.keys(catalog));
  const sub = pick(Object.keys(catalog[cat]));
  const product = pick(catalog[cat][sub]);
  const d = new Date(start + Math.floor(rand() * 730) * 86400000);
  // Seasonality: Q4 orders are larger.
  const q4 = d.getUTCMonth() >= 9 ? 1.35 : 1;
  const qty = 1 + Math.floor(rand() * 6);
  const discount = pick([0, 0, 0, 0.1, 0.2, 0.3]);
  const sales = Math.round(basePrice[sub] * qty * (1 - discount) * q4 * (0.8 + rand() * 0.4) * 100) / 100;
  const profit = Math.round(sales * (0.25 - discount * 0.9 + (rand() - 0.5) * 0.1) * 100) / 100;

  let date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  if (rand() < 0.15) date = d.toISOString().slice(0, 10); // mixed date formats
  let regionText = region;
  if (rand() < 0.08) regionText = ` ${region.toLowerCase()} `; // casing + spaces
  let segment = c.segment;
  if (rand() < 0.05) segment = segment.toUpperCase();
  let salesText = sales.toFixed(2);
  if (rand() < 0.1) salesText = `$${sales.toLocaleString('en-US', { minimumFractionDigits: 2 })}`; // currency text
  let city = pick(regions[region]);
  if (rand() < 0.03) city = '';

  rows.push([`ORD-${10000 + i}`, date, pick(['Standard', 'Standard', 'Second Class', 'First Class', 'Same Day']), c.id, c.name, segment, regionText, city, cat, sub, product, salesText, String(qty), String(discount), profit.toFixed(2)]);
  if (rand() < 0.02) rows.push([...rows[rows.length - 1]]); // exact duplicates
  if (rand() < 0.01) rows.push(header.map(() => '')); // blank rows
}

const csv = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
fs.writeFileSync(path.join(out, 'superstore_messy.csv'), [header, ...rows].map((r) => r.map(csv).join(',')).join('\n') + '\n');

fs.writeFileSync(
  path.join(out, 'project_brief.md'),
  `# Project brief — Superstore Sales Performance Dashboard

**Client:** Superstore, a US office-supplies & technology retailer selling to consumers, corporates and home offices through 4 regions.

## Business problem
Management wants one dashboard to track sales and profitability for 2023-2024, see which regions,
categories and customer segments drive growth, and spot loss-making discounting.

## Required KPIs
1. Total Sales
2. Total Profit
3. Profit Margin % (Profit / Sales)
4. Total Orders (distinct orders) and Average Order Value
5. Total Customers (distinct)
6. Sales YoY growth %

## Required visuals
- Monthly sales trend
- Sales by Region and by Category
- Profit by Sub-Category (to find loss makers)
- Share of sales by customer Segment
- Detail matrix by Region and Category

## Slicers
Year, Region, Category, Segment

## Data cleaning notes
The export from the POS system is messy: mixed date formats, currency symbols in the Sales column,
inconsistent region names, duplicated and blank rows.

## Procedure for DAX
Create base measures first (sums and counts), then ratios using DIVIDE, then time intelligence
using a proper Date table. Keep all measures in one measure table with display folders.
`,
);
console.log(`Wrote ${rows.length} rows to ${path.join(out, 'superstore_messy.csv')}`);
