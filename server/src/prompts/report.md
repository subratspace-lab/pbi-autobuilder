Design the final one-page Power BI dashboard for this business.

## Business context, questions and KPIs
{{analysis}}

## Project brief (include every visual / KPI / slicer it asks for)
{{brief}}

## Available measures (table "_Measures")
{{measures}}

## Available columns for categories and slicers (table -> column (distinct values))
{{columns}}

## Visual types and their data roles
- card:                 Values = 1 measure  (one KPI per card)
- multiRowCard:         Values = several measures
- lineChart:            Category = 1 column (use the Date table, e.g. 'Date'[Year Month]), Y = 1+ measures, optional Series = 1 column
- clusteredBarChart:    Category = 1 column, Y = 1+ measures, optional Series   (rankings; set "sortDescending": true)
- clusteredColumnChart: Category = 1 column, Y = 1+ measures, optional Series
- donutChart:           Category = 1 column with <= 8 values, Y = 1 measure
- pivotTable (matrix):  Rows = 1+ columns, Columns = optional column, Values = measures
- tableEx (table):      Values = columns and/or measures
- slicer:               Values = 1 column (dates/years, categories)

## Pages
- The first page is the executive dashboard. Add more pages when the brief asks for them (working lists, critical accounts, summaries by segment, Q&A views).
- A page can have "filters": [{ "table": "...", "column": "...", "values": ["Yes"] }] so it only shows matching rows (e.g. a "Critical Accounts" page filtered on a flag column).
- A table visual (tableEx) lists record-level columns; give it "sortField" (a field object) and "sortDescending" to order it (e.g. by risk score).

## Rules
- Per page: 4-6 KPI cards, 3-6 charts, at most 1 matrix/table, 2-7 slicers. Layout is automatic: cards on top, charts in the middle, matrix/table at the bottom, slicers on the left.
- Every field must be an exact measure name (kind "measure", table "_Measures") or an exact column (kind "column" with its table).
- Value roles (Y, Values of cards/charts, Size) take measures, never raw columns. Slicers take columns.
- Each visual has a short business title that answers a question (e.g. "Sales trend by month").
- Pick a professional theme: 6-8 hex dataColors that fit the business, a white or very light background, dark foreground.

Return JSON exactly in this shape:
{
  "title": "Sales Performance Dashboard",
  "subtitle": "Revenue, profit and customers — FY overview",
  "pages": [
    { "name": "Executive Overview", "visuals": [
      { "type": "card", "title": "Total Sales", "fields": [ { "role": "Values", "field": { "kind": "measure", "table": "_Measures", "name": "Total Sales" } } ] },
      { "type": "lineChart", "title": "Sales trend", "fields": [
          { "role": "Category", "field": { "kind": "column", "table": "Date", "name": "Year Month" } },
          { "role": "Y", "field": { "kind": "measure", "table": "_Measures", "name": "Total Sales" } } ] }
    ] },
    { "name": "Returned Orders", "filters": [ { "table": "Sales", "column": "Returned", "values": ["Yes"] } ], "visuals": [ … ] }
  ],
  "theme": { "name": "Corporate Blue", "dataColors": ["#1E40AF", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6", "#06B6D4"], "background": "#FFFFFF", "foreground": "#1F2937", "tableAccent": "#1E40AF" }
}
