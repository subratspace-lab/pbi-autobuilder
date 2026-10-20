Write the DAX measures for this Power BI model.

## Business context and KPIs
{{analysis}}

## Project brief (follow any measure procedure / naming it requires)
{{brief}}

## Model tables and columns (exact names)
{{tables}}

## Date table
{{dateTable}}

## Rules
- Measures live in a table called "_Measures"; reference other measures as [Measure Name] (no table prefix).
- Always reference columns with the table in single quotes: 'Table Name'[Column Name]. Use only the tables/columns listed above.
- Build in layers: base measures (SUM, COUNTROWS, DISTINCTCOUNT, AVERAGE) -> ratios with DIVIDE() -> time intelligence (YTD, PY with SAMEPERIODLASTYEAR, YoY %, MoM %) using the Date table's 'Date'[Date] column -> ranking/Top N if useful.
- Cover EVERY KPI from the business context.
- Measure names are business friendly and must not equal any column name.
- Use VAR/RETURN for anything non-trivial; use "\n" for line breaks inside the expression.
- formatString examples: "#,0", "#,0.00", "0.0%", "$#,0". displayFolder one of: "Base", "Ratios", "Time Intelligence", "Ranking".
- description: one sentence explaining the business meaning.
- Do NOT start an expression with "=".

Return JSON exactly in this shape:
{
  "measures": [
    { "name": "Total Sales", "expression": "SUM('Sales'[Sales])", "formatString": "#,0", "displayFolder": "Base", "description": "Revenue from all orders." }
  ]
}
