/**
 * SQL 執行器 — 查詢、列表、描述 + CSV 匯出
 */
import type odbc from 'odbc'
import { writeFile } from 'fs/promises'
import { type ConnectionConfig, withConnection } from './connection.js'
import { validateSQL, ensureLimit } from './safety.js'

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  elapsed: number
}

export interface TableInfo {
  name: string
  type: 'TABLE' | 'VIEW'
  owner: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  foreignKey?: { table: string; column: string }
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
}

export interface DescribeResult {
  columns: ColumnInfo[]
  indexes: IndexInfo[]
}

/**
 * 執行 SELECT 查詢
 */
export async function executeQuery(
  config: ConnectionConfig,
  sql: string,
  limit: number = 100,
  outputFile?: string,
): Promise<QueryResult> {
  const check = validateSQL(sql)
  if (!check.ok) {
    throw new Error(check.error)
  }

  const safeSql = ensureLimit(check.sql, limit)
  const start = Date.now()

  return withConnection(config, async (conn: odbc.Connection) => {
    const result = await conn.query(safeSql)
    const elapsed = Date.now() - start

    const columns = result.columns
      ? result.columns.map((c: { name: string }) => c.name)
      : (result.length > 0 ? Object.keys(result[0] as Record<string, unknown>) : [])

    const rows = result.map((row: Record<string, unknown>) =>
      columns.map((col: string) => row[col]),
    )

    // CSV 匯出
    if (outputFile && rows.length > 0) {
      const csv = toCsv(columns, rows)
      await writeFile(outputFile, csv, 'utf-8')
    }

    return { columns, rows, rowCount: rows.length, elapsed }
  })
}

/**
 * 列出所有 table 和 view
 * 使用 Informix systables 系統表
 */
export async function listTables(
  config: ConnectionConfig,
  schema?: string,
): Promise<{ tables: TableInfo[] }> {
  return withConnection(config, async (conn: odbc.Connection) => {
    // Informix systables: tabtype = 'T' (table), 'V' (view)
    let sql = `SELECT TRIM(tabname) AS name, tabtype, TRIM(owner) AS owner
               FROM systables
               WHERE tabtype IN ('T', 'V')
                 AND tabid >= 100`

    if (schema) {
      sql += ` AND owner = '${escapeString(schema)}'`
    }

    sql += ` ORDER BY tabname`

    const result = await conn.query(sql)
    const tables: TableInfo[] = result.map((row: Record<string, unknown>) => ({
      name: String(row.name || row.NAME || '').trim(),
      type: (String(row.tabtype || row.TABTYPE || '').trim() === 'V' ? 'VIEW' : 'TABLE') as 'TABLE' | 'VIEW',
      owner: String(row.owner || row.OWNER || '').trim(),
    }))

    return { tables }
  })
}

/**
 * 查看 table 的欄位結構、外鍵、索引
 * 使用 Informix syscolumns / sysconstraints / sysindexes 系統表
 */
export async function describeTable(
  config: ConnectionConfig,
  table: string,
  schema?: string,
): Promise<DescribeResult> {
  return withConnection(config, async (conn: odbc.Connection) => {
    const escapedTable = escapeString(table)

    // 取得 tabid
    let tabidSql = `SELECT tabid FROM systables WHERE tabname = '${escapedTable}'`
    if (schema) {
      tabidSql += ` AND owner = '${escapeString(schema)}'`
    }

    const tabidResult = await conn.query(tabidSql)
    if (tabidResult.length === 0) {
      throw new Error(`Table not found: ${table}`)
    }
    const tabid = (tabidResult[0] as Record<string, unknown>).tabid as number

    // 取得欄位資訊
    const columnsSql = `SELECT colname, coltype, collength,
                               CASE WHEN MOD(coltype, 256) > 0 THEN 1 ELSE 0 END AS coltype_raw
                        FROM syscolumns
                        WHERE tabid = ${tabid}
                        ORDER BY colno`
    const colResult = await conn.query(columnsSql)

    // 取得主鍵欄位
    const pkCols = await getPrimaryKeyColumns(conn, tabid)

    // 取得外鍵資訊
    const fkMap = await getForeignKeys(conn, tabid)

    const columns: ColumnInfo[] = colResult.map((row: Record<string, unknown>) => {
      const colname = String(row.colname || row.COLNAME || '').trim()
      const coltype = Number(row.coltype || row.COLTYPE || 0)
      const collength = Number(row.collength || row.COLLENGTH || 0)

      return {
        name: colname,
        type: informixTypeToString(coltype, collength),
        // Informix: coltype 高位 bit 表示 NOT NULL（coltype + 256 = NOT NULL）
        nullable: coltype < 256,
        primaryKey: pkCols.has(colname),
        ...(fkMap.has(colname) ? { foreignKey: fkMap.get(colname) } : {}),
      }
    })

    // 取得索引資訊
    const indexes = await getIndexes(conn, tabid)

    return { columns, indexes }
  })
}

/**
 * 取得主鍵欄位名稱集合
 */
async function getPrimaryKeyColumns(conn: odbc.Connection, tabid: number): Promise<Set<string>> {
  try {
    const sql = `SELECT TRIM(c.colname) AS colname
                 FROM sysconstraints sc, sysindexes si, syscolumns c
                 WHERE sc.tabid = ${tabid}
                   AND sc.constrtype = 'P'
                   AND sc.idxname = si.idxname
                   AND si.tabid = c.tabid
                   AND (si.part1 = c.colno OR si.part2 = c.colno
                     OR si.part3 = c.colno OR si.part4 = c.colno
                     OR si.part5 = c.colno OR si.part6 = c.colno
                     OR si.part7 = c.colno OR si.part8 = c.colno)`

    const result = await conn.query(sql)
    return new Set(result.map((r: Record<string, unknown>) =>
      String(r.colname || r.COLNAME || '').trim()
    ))
  } catch {
    return new Set()
  }
}

/**
 * 取得外鍵資訊
 */
async function getForeignKeys(
  conn: odbc.Connection,
  tabid: number,
): Promise<Map<string, { table: string; column: string }>> {
  const map = new Map<string, { table: string; column: string }>()
  try {
    const sql = `SELECT TRIM(fc.colname) AS fk_col,
                        TRIM(rt.tabname) AS ref_table,
                        TRIM(rc.colname) AS ref_col
                 FROM sysconstraints sc
                 JOIN sysreferences sr ON sc.constrid = sr.constrid
                 JOIN sysconstraints pc ON sr.primary = pc.constrid
                 JOIN sysindexes fi ON sc.idxname = fi.idxname
                 JOIN syscolumns fc ON fi.tabid = fc.tabid AND fi.part1 = fc.colno
                 JOIN sysindexes pi ON pc.idxname = pi.idxname
                 JOIN syscolumns rc ON pi.tabid = rc.tabid AND pi.part1 = rc.colno
                 JOIN systables rt ON pc.tabid = rt.tabid
                 WHERE sc.tabid = ${tabid}
                   AND sc.constrtype = 'R'`

    const result = await conn.query(sql)
    for (const row of result) {
      const r = row as Record<string, unknown>
      map.set(
        String(r.fk_col || r.FK_COL || '').trim(),
        {
          table: String(r.ref_table || r.REF_TABLE || '').trim(),
          column: String(r.ref_col || r.REF_COL || '').trim(),
        },
      )
    }
  } catch {
    // FK 查詢失敗不影響主結果
  }
  return map
}

/**
 * 取得索引資訊
 */
async function getIndexes(conn: odbc.Connection, tabid: number): Promise<IndexInfo[]> {
  try {
    const sql = `SELECT TRIM(si.idxname) AS name,
                        si.idxtype,
                        si.part1, si.part2, si.part3, si.part4,
                        si.part5, si.part6, si.part7, si.part8
                 FROM sysindexes si
                 WHERE si.tabid = ${tabid}
                   AND si.idxname NOT LIKE ' %'`

    const result = await conn.query(sql)
    const indexes: IndexInfo[] = []

    for (const row of result) {
      const r = row as Record<string, unknown>
      const parts = [r.part1, r.part2, r.part3, r.part4,
                     r.part5, r.part6, r.part7, r.part8] as number[]
      const colNos = parts.filter(p => p && p > 0).map(Math.abs)

      if (colNos.length === 0) continue

      // 查欄位名
      const colNames = await Promise.all(colNos.map(async (colno) => {
        const colSql = `SELECT TRIM(colname) AS colname FROM syscolumns WHERE tabid = ${tabid} AND colno = ${colno}`
        const colResult = await conn.query(colSql)
        return colResult.length > 0
          ? String((colResult[0] as Record<string, unknown>).colname || '').trim()
          : `col${colno}`
      }))

      indexes.push({
        name: String(r.name || r.NAME || '').trim(),
        columns: colNames,
        unique: String(r.idxtype || r.IDXTYPE || '').trim() === 'U',
      })
    }

    return indexes
  } catch {
    return []
  }
}

/**
 * Informix coltype 數值轉可讀字串
 */
function informixTypeToString(coltype: number, collength: number): string {
  // 去掉 NOT NULL bit（256）
  const baseType = coltype % 256

  const typeMap: Record<number, string> = {
    0: 'CHAR',
    1: 'SMALLINT',
    2: 'INTEGER',
    3: 'FLOAT',
    4: 'SMALLFLOAT',
    5: 'DECIMAL',
    6: 'SERIAL',
    7: 'DATE',
    8: 'MONEY',
    9: 'NULL',
    10: 'DATETIME',
    11: 'BYTE',
    12: 'TEXT',
    13: 'VARCHAR',
    14: 'INTERVAL',
    15: 'NCHAR',
    16: 'NVARCHAR',
    17: 'INT8',
    18: 'SERIAL8',
    40: 'LVARCHAR',
    41: 'BOOLEAN',
    43: 'BIGSERIAL',
    52: 'BIGINT',
    262: 'SERIAL',       // 含 NOT NULL
    265: 'DECIMAL',      // 含 NOT NULL
  }

  const name = typeMap[baseType] || `TYPE_${baseType}`

  // 對字串型別顯示長度
  if ([0, 13, 15, 16, 40].includes(baseType) && collength > 0) {
    return `${name}(${collength})`
  }

  // DECIMAL/MONEY 顯示精度
  if ([5, 8].includes(baseType) && collength > 0) {
    const precision = Math.floor(collength / 256)
    const scale = collength % 256
    return `${name}(${precision},${scale})`
  }

  return name
}

/**
 * 簡易字串逸出（防止 SQL injection 在系統表查詢中）
 */
function escapeString(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * 將查詢結果轉為 CSV 字串
 */
function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const header = columns.map(escape).join(',')
  const body = rows.map(row => row.map(escape).join(',')).join('\n')
  return header + '\n' + body + '\n'
}
