Propose the Power Query cleaning steps for each table. Steps run in order, after headers are promoted.

## Business context
{{analysis}}

## Tables (profile + sample rows)
{{profiles}}

## Allowed operations (use ONLY these, exact field names)
- {"op":"trim","columns":["A","B"]}                       remove leading/trailing spaces
- {"op":"clean","columns":["A"]}                          remove non-printable characters
- {"op":"properCase"|"upperCase"|"lowerCase","columns":["A"]}  fix inconsistent casing
- {"op":"emptyToNull","columns":["A"]}                    "" -> null
- {"op":"replaceValues","column":"A","find":"N/A","replace":null,"wholeValue":true}   whole-cell replace (wholeValue=false replaces text inside cells, e.g. remove "$")
- {"op":"replaceNulls","column":"A","value":"Unknown"}
- {"op":"setType","column":"A","type":"text|number|integer|currency|date|datetime|boolean"}
- {"op":"removeDuplicates"}  or  {"op":"removeDuplicates","columns":["Order ID"]}
- {"op":"removeBlankRows"}
- {"op":"removeRowsWithBlank","column":"A"}
- {"op":"fillDown","columns":["A"]}
- {"op":"splitColumn","column":"Name","delimiter":" ","newColumns":["First Name","Last Name"]}
- {"op":"addColumn","name":"Profit","spec":{"kind":"arithmetic","left":"Sales","operator":"-","right":"Cost"}}   right may be a column name or a number
- {"op":"addColumn","name":"Order Year","spec":{"kind":"datePart","column":"Order Date","part":"year|month|monthName|quarter|day|weekdayName|age"}}   ("age" = whole years until today, e.g. from a date of birth)
- {"op":"addColumn","name":"DPD Bucket","spec":{"kind":"bucket","column":"DPD","bounds":[0,30,60,90],"labels":["Current","1-30","31-60","61-90","90+"]}}   numeric bands: value <= bounds[i] gets labels[i], above the last bound gets the last label (labels = bounds + 1). A hidden sort column is added automatically.
- {"op":"addColumn","name":"Full Name","spec":{"kind":"concat","columns":["First","Last"],"separator":" "}}
- {"op":"addColumn","name":"Size","spec":{"kind":"conditional","column":"Sales","operator":"greaterThan","value":1000,"then":"Large","else":"Small"}}
- {"op":"addColumn","name":"DTI %","spec":{"kind":"arithmetic","left":"Monthly Debt","operator":"/","right":"Monthly Income","scale":100,"round":2}}   scale/round are optional
- {"op":"addColumn","name":"DPD Score","spec":{"kind":"bucket","column":"DPD","bounds":[0,30,60,90,179],"labels":[0,10,15,20,30,40],"numeric":true}}   numeric bands = score points
- {"op":"addColumn","name":"Risk Score","spec":{"kind":"sum","columns":["DPD Score","Bureau Points"]}}
- {"op":"addColumn","name":"Critical","spec":{"kind":"cases","cases":[{"column":"Risk Score","operator":"greaterThan","value":60,"then":"Yes"},{"column":"DPD","operator":"greaterThan","value":90,"then":"Yes"}],"else":"No"}}   first matching rule wins (OR); for AND conditions list the failing cases first with then "No" and else "Yes"
- {"op":"addRank","name":"Risk Rank","column":"Risk Score","descending":true}
- {"op":"mergeTable","table":"Bureau Dataset","leftKey":"Customer ID","rightKey":"Customer ID"}   left join another table and bring its new columns (optional "columns": [...]); use it when the brief asks for one consolidated table
- {"op":"rename","from":"cust_nm","to":"Customer Name"}
- {"op":"removeColumns","columns":["Unused"]}
- {"op":"filterRows","column":"Sales","operator":"equals|notEquals|greaterThan|lessThan|greaterOrEqual|lessOrEqual|contains|notContains|isNotBlank","value":0}

## Rules
- Column names must match the profile exactly. After a rename/split, later steps must use the NEW name.
- Fix text first (trim, casing, replace typos/placeholders like "N/A", "-", "?"), then set types.
- Set every date column to "date", every measure-like numeric column to "number"/"integer"/"currency". Keep IDs, codes, phone and ZIP columns as "text".
- Rename cryptic columns to business-friendly names (e.g. "cust_nm" -> "Customer Name").
- Only remove duplicates/rows when the profile shows the problem. Do not invent problems.
- Add derived columns only when they serve the KPIs (e.g. Profit = Sales - Cost if not present; DPD / credit-score / age bands for risk analysis).
- Every op has a short "reason" explaining the business reason; optional "title" (Applied Steps name).

Return JSON exactly in this shape:
{ "tables": [ { "table": "Orders", "ops": [ { "op": "trim", "columns": ["Region"], "reason": "..." } ] } ] }
