/**
 * M2-09：FTS 歷史對話搜尋 — 用 session index 的 FTS5 搜尋相關對話片段。
 *
 * 給 prefetch 模組使用：user query 進來時搜歷史、注入 context。
 * 複用 M2-01~03 的 sessionIndex 基礎設施。
 */
import {
  ensureReconciled,
  openSessionIndex,
} from '../sessionIndex/index.js'

// ── 型別 ────────────────────────────────────────────────────────────

export interface FtsSnippet {
  sessionId: string
  role: string
  content: string       // 截斷後的片段
  startedAt: number     // session 開始時間（ms epoch）
}

// ── 常數 ────────────────────────────────────────────────────────────

const MIN_FTS_QUERY_LEN = 3
const DEFAULT_LIMIT = 3
const SNIPPET_MAX_CHARS = 300

// ── helpers ─────────────────────────────────────────────────────────

/**
 * FTS5 query sanitizer — 複用自 SessionSearchTool 的邏輯。
 * 把 query 按空白切、每段包 phrase literal `"..."`、過濾 <3 char token。
 * Token 間用 OR 連接（中英混合 keyword 較實用）。
 * 全部 token 被過濾掉時回空字串。
 */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= MIN_FTS_QUERY_LEN)
  if (tokens.length === 0) return ''
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function truncate(s: string, max = SNIPPET_MAX_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

// ── 主 export ───────────────────────────────────────────────────────

/**
 * 搜尋 session 歷史中與 query 相關的對話片段。
 *
 * - query <3 char → 回空陣列（prefetch 不值得做 LIKE fallback）
 * - 過濾 role='tool'（工具輸出通常不是有用 context）
 * - 每筆 content 截斷到 SNIPPET_MAX_CHARS
 * - 結果按 BM25 rank 排序（越相關越前面）
 *
 * 失敗時回空陣列（不拋錯）。
 */
export async function searchSessionHistory(
  query: string,
  projectRoot: string,
  limit: number = DEFAULT_LIMIT,
): Promise<FtsSnippet[]> {
  if (!query || query.trim().length < MIN_FTS_QUERY_LEN) return []

  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  try {
    await ensureReconciled(projectRoot)
  } catch {
    // reconcile 失敗不致命
  }

  try {
    const db = openSessionIndex(projectRoot)

    const rows = db
      .query<
        {
          session_id: string
          role: string
          content: string
          started_at: number
        },
        [string, number]
      >(
        `SELECT m.session_id, m.role, m.content, s.started_at
         FROM messages_fts m
         JOIN sessions s ON s.session_id = m.session_id
         WHERE messages_fts MATCH ?
           AND m.role != 'tool'
         ORDER BY m.rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit)

    return rows.map(r => ({
      sessionId: r.session_id,
      role: r.role,
      content: truncate(r.content),
      startedAt: r.started_at,
    }))
  } catch {
    // FTS parse 失敗或 DB 損毀 → 回空
    return []
  }
}
