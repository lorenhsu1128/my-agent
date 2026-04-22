/**
 * Session 刪除 + 列表 API（M-DELETE-2）。
 *
 * - deleteSession：transaction 刪除 sessions + messages_fts + messages_seen 三表
 *   → DB 記錄硬刪；檔案系統的 JSONL / tool-results 由呼叫端另行處理（見 sessionStorage.moveSessionToTrash）
 * - listSessions：給 picker UI 顯示用的 metadata 列表，支援時間範圍與 keyword filter
 */
import type { Database } from 'bun:sqlite'
import { openSessionIndex } from './db.js'

export type SessionSummary = {
  sessionId: string
  startedAt: number
  endedAt: number | null
  model: string | null
  messageCount: number
  firstUserMessage: string | null
  totalInputTokens: number
  totalOutputTokens: number
  estimatedCostUsd: number | null
  lastIndexedAt: number | null
  parentSessionId: string | null
}

export type ListSessionsOptions = {
  /** 起點 epoch ms（含）；undefined = 不限 */
  sinceMs?: number
  /** 終點 epoch ms（含）；undefined = 不限 */
  untilMs?: number
  /** 關鍵字過濾 — 對 first_user_message LIKE */
  keyword?: string
  limit?: number
  offset?: number
}

type SessionRow = {
  session_id: string
  started_at: number
  ended_at: number | null
  model: string | null
  message_count: number
  first_user_message: string | null
  total_input_tokens: number
  total_output_tokens: number
  estimated_cost_usd: number | null
  last_indexed_at: number | null
  parent_session_id: string | null
}

function rowToSummary(row: SessionRow): SessionSummary {
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    model: row.model,
    messageCount: row.message_count,
    firstUserMessage: row.first_user_message,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    lastIndexedAt: row.last_indexed_at,
    parentSessionId: row.parent_session_id,
  }
}

/** 列出 sessions，依 started_at DESC 排序。 */
export function listSessions(
  cwd: string,
  opts: ListSessionsOptions = {},
): SessionSummary[] {
  const db = openSessionIndex(cwd)
  return listSessionsWithDb(db, opts)
}

export function listSessionsWithDb(
  db: Database,
  opts: ListSessionsOptions = {},
): SessionSummary[] {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (opts.sinceMs !== undefined) {
    clauses.push('started_at >= ?')
    params.push(opts.sinceMs)
  }
  if (opts.untilMs !== undefined) {
    clauses.push('started_at <= ?')
    params.push(opts.untilMs)
  }
  if (opts.keyword && opts.keyword.trim().length > 0) {
    clauses.push(
      '(first_user_message LIKE ? OR session_id LIKE ? OR model LIKE ?)',
    )
    const pattern = `%${opts.keyword.trim()}%`
    params.push(pattern, pattern, pattern)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = opts.limit ?? 200
  const offset = opts.offset ?? 0
  const sql = `
    SELECT session_id, started_at, ended_at, model, message_count,
           first_user_message, total_input_tokens, total_output_tokens,
           estimated_cost_usd, last_indexed_at, parent_session_id
    FROM sessions
    ${where}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `
  const rows = db
    .query(sql)
    .all(...params, limit, offset) as unknown as SessionRow[]
  return rows.map(rowToSummary)
}

export type DeleteSessionResult = {
  sessionId: string
  /** 是否真的刪到（false = sessions 表原本就沒這個 id） */
  existed: boolean
  /** 刪掉的 messages_fts 行數 */
  ftsDeleted: number
  /** 刪掉的 messages_seen 行數 */
  seenDeleted: number
}

/**
 * 硬刪除 session 的 DB 紀錄（不動檔案系統）。
 * transaction 包三個 DELETE 保原子性。
 */
export function deleteSession(
  cwd: string,
  sessionId: string,
): DeleteSessionResult {
  const db = openSessionIndex(cwd)
  return deleteSessionWithDb(db, sessionId)
}

export function deleteSessionWithDb(
  db: Database,
  sessionId: string,
): DeleteSessionResult {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('deleteSession: sessionId required')
  }
  // 先查是否存在
  const existing = db
    .query('SELECT session_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { session_id: string } | null

  const runDelete = db.transaction(() => {
    // FTS5 virtual table 的 DELETE changes() 在某些環境回 0，改用 SELECT COUNT 預先量測。
    const ftsCount = db
      .query('SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?')
      .get(sessionId) as { c: number }
    db.query('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId)
    const seenRes = db
      .query('DELETE FROM messages_seen WHERE session_id = ?')
      .run(sessionId)
    db.query('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
    return {
      ftsDeleted: ftsCount.c,
      seenDeleted: Number(seenRes.changes ?? 0),
    }
  })

  const { ftsDeleted, seenDeleted } = runDelete()
  return {
    sessionId,
    existed: existing !== null,
    ftsDeleted,
    seenDeleted,
  }
}
