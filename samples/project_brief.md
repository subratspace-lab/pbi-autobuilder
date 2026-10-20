# Project brief — Superstore Sales Performance Dashboard

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
