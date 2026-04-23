/**
 * SQL 安全層 — SELECT-only 強制 + 自動 FIRST 附加
 */

// 禁止的 SQL 關鍵字（正規化為大寫後比對）
const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'EXECUTE', 'CALL', 'GRANT', 'REVOKE',
] as const

// 禁止的片語（正規化為大寫後比對）
const BLOCKED_PHRASES = [
  'INTO TEMP',
  'INTO EXTERNAL',
] as const

export interface SafetyCheckResult {
  ok: boolean
  sql: string
  error?: string
}

/**
 * 移除 SQL 註解（單行 -- 和多行 /* *​/ ）
 */
function stripComments(sql: string): string {
  // 移除多行註解
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // 移除單行註解
  result = result.replace(/--[^\n]*/g, ' ')
  return result
}

/**
 * 正規化 SQL：去註解、trim、壓縮空白
 */
function normalize(sql: string): string {
  return stripComments(sql).replace(/\s+/g, ' ').trim()
}

/**
 * 檢查 SQL 是否安全（SELECT-only）
 */
export function validateSQL(sql: string): SafetyCheckResult {
  const normalized = normalize(sql)

  if (!normalized) {
    return { ok: false, sql, error: 'Empty SQL statement' }
  }

  // 禁止多語句（分號分隔）
  // 允許末尾的分號，但不允許中間的
  const trimmedSemicolon = normalized.replace(/;\s*$/, '')
  if (trimmedSemicolon.includes(';')) {
    return { ok: false, sql, error: 'Multiple statements not allowed (semicolons detected)' }
  }

  const upper = normalized.toUpperCase()

  // 必須以 SELECT 開頭（允許前置空白，已被 trim 處理）
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { ok: false, sql, error: 'Only SELECT (and WITH ... SELECT) statements are allowed' }
  }

  // 檢查禁止的關鍵字（作為獨立 token 出現）
  for (const keyword of BLOCKED_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    if (regex.test(upper)) {
      return { ok: false, sql, error: `Blocked keyword detected: ${keyword}` }
    }
  }

  // 檢查禁止的片語
  for (const phrase of BLOCKED_PHRASES) {
    if (upper.includes(phrase)) {
      return { ok: false, sql, error: `Blocked phrase detected: ${phrase}` }
    }
  }

  return { ok: true, sql: trimmedSemicolon }
}

/**
 * 若 SQL 不含 FIRST 子句，自動在 SELECT 後加 FIRST {limit}
 * Informix 語法：SELECT FIRST 100 * FROM ...
 */
export function ensureLimit(sql: string, limit: number): string {
  const upper = sql.toUpperCase().trim()

  // 已有 FIRST 子句就不動
  if (/\bFIRST\s+\d+/i.test(sql)) {
    return sql
  }

  // WITH ... SELECT 的情況：找到最外層 SELECT 再加
  if (upper.startsWith('WITH')) {
    // 找到 WITH CTE 之後的主 SELECT
    const selectMatch = sql.match(/\)\s*(SELECT)/i)
    if (selectMatch && selectMatch.index !== undefined) {
      const insertPos = selectMatch.index + selectMatch[0].length
      return sql.slice(0, insertPos) + ` FIRST ${limit}` + sql.slice(insertPos)
    }
  }

  // 普通 SELECT：在 SELECT 後加 FIRST
  if (upper.startsWith('SELECT')) {
    return sql.replace(/^SELECT/i, `SELECT FIRST ${limit}`)
  }

  return sql
}
