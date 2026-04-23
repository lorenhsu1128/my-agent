export const INFORMIX_QUERY_TOOL_NAME = 'InformixQuery'

export const DESCRIPTION = `Query an IBM Informix 12.x database. Read-only — SELECT queries only.

## HARD RULES
1. ALWAYS explore schema first: list_tables → describe_table → query
2. NEVER guess table or column names — Informix names are case-sensitive
3. Use FIRST N instead of LIMIT N (Informix syntax)
4. For date ranges use: WHERE col BETWEEN '2024-01-01' AND '2024-12-31'
5. For CSV export: set output_file parameter
6. For cross-table queries: describe ALL relevant tables FIRST to check column names and foreign keys

## Workflow
1. action="list_tables" — see available tables and views
2. action="describe_table", table="xxx" — check columns, types, FKs, indexes
3. action="query", sql="SELECT ..." — run the actual query

## Informix SQL quick reference (vs MySQL/PostgreSQL)
- Row limit: SELECT FIRST 10 * FROM t  (NOT "LIMIT 10")
- String concat: col1 || col2  (NOT CONCAT())
- Current date: TODAY (date only) / CURRENT (datetime)
- Current time: CURRENT HOUR TO SECOND
- Substring: SUBSTR(col, start, len)
- Null handling: NVL(col, default)  (COALESCE also works in 12.x)
- OUTER join: ANSI syntax — LEFT OUTER JOIN t2 ON t1.id = t2.id
- Case: CASE WHEN x THEN y ELSE z END (same as standard SQL)
- Date format: MDY(month, day, year) or TO_DATE('2024-01-01', '%Y-%m-%d')
- String trim: TRIM(col) / LTRIM(col) / RTRIM(col)

## Output formats
- query: { columns, rows, rowCount, elapsed } — rows are arrays of values matching column order
- list_tables: { tables: [{ name, type, owner }] }
- describe_table: { columns: [{ name, type, nullable, primaryKey, foreignKey? }], indexes: [...] }

## Tips
- Auto LIMIT: if your SQL has no FIRST clause, the tool automatically adds FIRST <limit> to prevent pulling the entire table
- The limit parameter defaults to 100, max 1000
- Use output_file to save results as CSV for further processing
- Use connection parameter to query a specific named connection (default: "default")
`
