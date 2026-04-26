/**
 * M-WEB-18：sessionIndex read API — list sessions / get messages / FTS search。
 *
 * 三個函式都直接 query 已 reconciled 的 SQLite；caller（restRoutes）拿到結果
 * 即可序列化回 browser。
 *
 * 注意：FTS5 trigram tokenizer 對 query 至少 3 chars 才會比對；caller 應自己
 * 過濾過短 query。
 */
import { openSessionIndex } from './db.js'

export interface SessionRow {
  sessionId: string
  startedAt: number
  endedAt: number | null
  model: string | null
  messageCount: number
  firstUserMessage: string | null
  totalInputTokens: number
  totalOutputTokens: number
  parentSessionId: string | null
}

export interface IndexedMessage {
  sessionId: string
  messageIndex: number
  role: string
  timestamp: number
  toolName: string | null
  finishReason: string | null
  content: string
}

export interface SearchHit extends IndexedMessage {
  /** FTS5 rank（越小越相關，bm25-like）。 */
  rank: number
  /** content 的高亮片段（snippet()）。 */
  snippet: string
}

/**
 * 列 project 內的 sessions（最新優先）。
 */
export function listSessionsForProject(
  cwd: string,
  limit = 100,
): SessionRow[] {
  const db = openSessionIndex(cwd)
  const rows = db
    .query<
      {
        session_id: string
        started_at: number
        ended_at: number | null
        model: string | null
        message_count: number
        first_user_message: string | null
        total_input_tokens: number
        total_output_tokens: number
        parent_session_id: string | null
      },
      [number]
    >(
      `SELECT session_id, started_at, ended_at, model, message_count,
              first_user_message, total_input_tokens, total_output_tokens,
              parent_session_id
         FROM sessions
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(limit)
  return rows.map(r => ({
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    model: r.model,
    messageCount: r.message_count,
    firstUserMessage: r.first_user_message,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    parentSessionId: r.parent_session_id,
  }))
}

/**
 * 抓某 session 最近 N 條訊息（按 message_index 倒序，回時 reverse 成正序方便顯示）。
 * before：取 message_index < before 的訊息（用於上滑 lazy load）。
 */
export function getMessagesBySession(
  cwd: string,
  sessionId: string,
  opts: { before?: number; limit?: number } = {},
): IndexedMessage[] {
  const limit = opts.limit ?? 100
  const before = opts.before
  const db = openSessionIndex(cwd)
  const sql =
    before !== undefined
      ? `SELECT session_id, message_index, role, timestamp, tool_name,
                finish_reason, content
           FROM messages_fts
          WHERE session_id = ? AND message_index < ?
          ORDER BY message_index DESC
          LIMIT ?`
      : `SELECT session_id, message_index, role, timestamp, tool_name,
                finish_reason, content
           FROM messages_fts
          WHERE session_id = ?
          ORDER BY message_index DESC
          LIMIT ?`
  const rows =
    before !== undefined
      ? db
          .query<
            {
              session_id: string
              message_index: number
              role: string
              timestamp: number
              tool_name: string | null
              finish_reason: string | null
              content: string
            },
            [string, number, number]
          >(sql)
          .all(sessionId, before, limit)
      : db
          .query<
            {
              session_id: string
              message_index: number
              role: string
              timestamp: number
              tool_name: string | null
              finish_reason: string | null
              content: string
            },
            [string, number]
          >(sql)
          .all(sessionId, limit)
  // 倒序拿、回時 reverse → 訊息按 message_index 正序給 caller
  return rows
    .slice()
    .reverse()
    .map(r => ({
      sessionId: r.session_id,
      messageIndex: r.message_index,
      role: r.role,
      timestamp: r.timestamp,
      toolName: r.tool_name,
      finishReason: r.finish_reason,
      content: r.content,
    }))
}

/**
 * Project 範圍 FTS 搜尋。query 太短（< 3 char）回空陣列避免 trigram 警告。
 */
export function searchProject(
  cwd: string,
  query: string,
  limit = 50,
): SearchHit[] {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []
  const db = openSessionIndex(cwd)
  // SQLite FTS5 MATCH：用 simple phrase 匹配；包雙引號避免特殊字元解析
  const escaped = trimmed.replace(/"/g, '""')
  const matchExpr = `"${escaped}"`
  try {
    const rows = db
      .query<
        {
          session_id: string
          message_index: number
          role: string
          timestamp: number
          tool_name: string | null
          finish_reason: string | null
          content: string
          rank: number
          snippet: string
        },
        [string, number]
      >(
        `SELECT session_id, message_index, role, timestamp, tool_name,
                finish_reason, content,
                rank,
                snippet(messages_fts, -1, '<mark>', '</mark>', ' … ', 16) AS snippet
           FROM messages_fts
          WHERE messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(matchExpr, limit)
    return rows.map(r => ({
      sessionId: r.session_id,
      messageIndex: r.message_index,
      role: r.role,
      timestamp: r.timestamp,
      toolName: r.tool_name,
      finishReason: r.finish_reason,
      content: r.content,
      rank: r.rank,
      snippet: r.snippet,
    }))
  } catch (err) {
    // FTS query 字串解析失敗時 graceful fail — 回空避免 500
    // eslint-disable-next-line no-console
    console.warn('[sessionIndex] search query failed:', err)
    return []
  }
}
