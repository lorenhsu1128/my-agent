/**
 * ODBC 連線管理
 */
import odbc from 'odbc'

export interface ConnectionConfig {
  dsn?: string
  host?: string
  port?: number
  database?: string
  server?: string
  username?: string
  password?: string
  protocol?: string
}

/**
 * 從 ConnectionConfig 組成 ODBC connection string
 * 若有 DSN 就用 DSN；否則用 host/port/database 組成 DSN-less 連線字串
 */
export function buildConnectionString(config: ConnectionConfig): string {
  if (config.dsn) {
    // DSN 模式：用系統 ODBC 設定的 DSN
    const parts = [`DSN=${config.dsn}`]
    if (config.username) parts.push(`UID=${config.username}`)
    if (config.password) parts.push(`PWD=${config.password}`)
    if (config.database) parts.push(`DATABASE=${config.database}`)
    return parts.join(';')
  }

  // DSN-less 模式：直接指定 Informix 連線參數
  const parts = ['DRIVER={IBM INFORMIX ODBC DRIVER}']
  if (config.host) parts.push(`HOST=${config.host}`)
  if (config.port) parts.push(`SERVICE=${config.port}`)
  if (config.server) parts.push(`SERVER=${config.server}`)
  if (config.database) parts.push(`DATABASE=${config.database}`)
  if (config.protocol) parts.push(`PROTOCOL=${config.protocol}`)
  if (config.username) parts.push(`UID=${config.username}`)
  if (config.password) parts.push(`PWD=${config.password}`)

  return parts.join(';')
}

/**
 * 建立 ODBC 連線並執行查詢
 */
export async function withConnection<T>(
  config: ConnectionConfig,
  fn: (conn: odbc.Connection) => Promise<T>,
): Promise<T> {
  const connStr = buildConnectionString(config)
  const conn = await odbc.connect(connStr)

  try {
    return await fn(conn)
  } finally {
    try {
      await conn.close()
    } catch {
      // 關閉失敗不影響結果
    }
  }
}
