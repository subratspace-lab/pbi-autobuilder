Design a star-schema data model for Power BI from the cleaned tables.

## Business context
{{analysis}}

## Cleaned tables (name -> columns with types, row count and distinct counts)
{{tables}}

## Rules
- Each model table is built from one cleaned table ("source"), keeping a subset of its columns.
- FACT tables hold the transactions/events (dates, amounts, foreign keys). DIMENSION tables hold descriptive attributes with one row per "key".
- If everything is in one flat table, split it: keep the fact table with keys + numbers + dates, and create dimensions (e.g. Customer, Product, Location) from the same source with a unique key column and its descriptive columns. A dimension key must be a column whose values identify one member (e.g. "Customer ID"); the fact keeps that key column so a relationship can be created. Do NOT copy descriptive columns into both fact and dimension.
- If there are several source tables, decide which are facts and which are dimensions and connect them on matching key columns.
- Relationships go from the fact (many side, "fromTable"/"fromColumn") to the dimension (one side, "toTable"/"toColumn"). Column names must exist in those model tables.
- Model table names: short business nouns (e.g. "Sales", "Customers", "Products"). Never "Date", "Calendar", "DataFolder" or "_Measures".
- dateTable: the main date column of the main fact table (it will be linked to a generated Date table). Must be a date column.

Return JSON exactly in this shape:
{
  "tables": [
    { "name": "Sales", "role": "fact", "source": "Orders", "columns": ["Order ID", "Order Date", "Customer ID", "Sales"] },
    { "name": "Customers", "role": "dimension", "source": "Orders", "columns": ["Customer ID", "Customer Name", "Segment"], "key": "Customer ID" }
  ],
  "relationships": [ { "fromTable": "Sales", "fromColumn": "Customer ID", "toTable": "Customers", "toColumn": "Customer ID" } ],
  "dateTable": { "table": "Sales", "column": "Order Date" }
}
