Understand the business behind this Power BI project before any technical work.

## Project brief (from the client)
{{brief}}

## Data profile (column stats + sample rows of each table)
{{profiles}}

## Transformation scripts supplied with the project (SQL / Python)
{{scripts}}

## Your task
1. Explain in plain business language what this business/process is and what the data records (4-6 sentences).
2. List the business questions the final dashboard must answer. If the brief lists required KPIs/visuals, include ALL of them.
3. Define the KPIs (name, business definition, formula hint using the real table/column names).
4. List concrete data-quality issues you see (table, column, problem).
5. Describe the ideal one-page dashboard in 2-3 sentences.

Return JSON exactly in this shape:
{
  "businessSummary": "string",
  "businessQuestions": ["string"],
  "kpis": [{ "name": "Total Sales", "definition": "Revenue from all orders", "formulaHint": "SUM(Orders[Sales])" }],
  "dataIssues": ["Orders[Region]: inconsistent casing (east / East)"],
  "dashboardIdea": "string"
}
