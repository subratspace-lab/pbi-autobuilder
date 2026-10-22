// Generates a messy e-commerce sales export matching the columns used by
// typical SQL / pandas transformation scripts:
//   OrderID, OrderDate, CustomerID, CustomerName, Product, Category,
//   Quantity, UnitPrice, Discount, Region, Status
// Usage: node scripts/make-ecommerce-sample.mjs   -> samples/ecommerce_sales.csv
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
fs.mkdirSync(out, { recursive: true });

let seed = 2024;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;

const catalog = {
  Electronics: [['Laptop', 55000], ['Smartphone', 22000], ['Tablet', 18000], ['Smartwatch', 9000]],
  Accessories: [['Headphones', 2500], ['Charger', 900], ['Phone Case', 450], ['Power Bank', 1600]],
  Home: [['Air Fryer', 6500], ['Mixer Grinder', 3800], ['LED Lamp', 1200]],
  Fashion: [['Sneakers', 3200], ['Backpack', 1900], ['Sunglasses', 1500]],
};
const first = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Rohan', 'Isha', 'Vivaan', 'Meera', 'Arjun', 'Sara', 'Neel', 'Tara'];
const last = ['Sharma', 'Iyer', 'Khan', 'Reddy', 'Patel', 'Das', 'Nair', 'Gupta', 'Singh', 'Mehta'];
const customers = Array.from({ length: 220 }, (_, i) => ({ id: `CUST${String(i + 1).padStart(4, '0')}`, name: `${pick(first)} ${pick(last)}` }));
const regions = ['North', 'South', 'East', 'West', 'Central'];
const statuses = ['Delivered', 'Delivered', 'Delivered', 'Shipped', 'Returned', 'Cancelled'];

const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const rows = [['OrderID', 'OrderDate', 'CustomerID', 'CustomerName', 'Product', 'Category', 'Quantity', 'UnitPrice', 'Discount', 'Region', 'Status']];
const start = Date.UTC(2024, 0, 1);

for (let i = 1; i <= 1500; i++) {
  const c = pick(customers);
  const cat = pick(Object.keys(catalog));
  const [product, price] = pick(catalog[cat]);
  const d = new Date(start + Math.floor(rand() * 640) * 86400000);
  const iso = d.toISOString().slice(0, 10);
  const row = {
    OrderID: `ORD${100000 + i}`,
    OrderDate: chance(0.15) ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : iso, // mixed formats
    CustomerID: c.id,
    CustomerName: c.name,
    Product: product,
    Category: cat,
    Quantity: 1 + Math.floor(rand() * 4),
    UnitPrice: Math.round(price * (0.9 + rand() * 0.2)),
    Discount: pick([0, 0, 0, 5, 10, 15, 20]),
    Region: pick(regions),
    Status: pick(statuses),
  };
  // The problems the transformation scripts fix:
  if (chance(0.08)) row.CustomerName = `  ${row.CustomerName} `; // stray spaces
  if (chance(0.06)) row.Status = row.Status.toLowerCase(); // inconsistent case
  if (chance(0.03)) row.CustomerName = ''; // missing → "Unknown"
  if (chance(0.03)) row.Category = ''; // missing → "Uncategorized"
  if (chance(0.03)) row.Region = ''; // missing → "Unknown"
  if (chance(0.02)) row.Status = '';
  if (chance(0.04)) row.Discount = ''; // missing → 0
  if (chance(0.02)) row.Quantity = 0; // invalid → removed
  if (chance(0.01)) row.UnitPrice = -1; // invalid → removed
  if (chance(0.01)) row.OrderDate = 'N/A'; // unparseable → removed
  if (chance(0.01)) row.OrderID = ' '; // missing ID → removed
  rows.push(Object.values(row));
  // Duplicate export of the same order (same OrderID), sometimes with a later date.
  if (chance(0.03)) {
    const dup = { ...row, OrderDate: new Date(d.getTime() + 86400000).toISOString().slice(0, 10) };
    rows.push(Object.values(dup));
  }
}

fs.writeFileSync(path.join(out, 'ecommerce_sales.csv'), rows.map((r) => r.map(csv).join(',')).join('\n') + '\n');
console.log(`Wrote ${rows.length - 1} rows to ${path.join(out, 'ecommerce_sales.csv')}`);
