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
 * CJK 字元範圍檢測。
 * 包含中文（CJK Unified）、日文（Hiragana/Katakana）、韓文（Hangul）。
 */
const CJK_REGEX = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/

/**
 * 從 CJK 文字中提取 trigram sliding window 作為 FTS query tokens。
 * FTS5 trigram tokenizer 用 3-char window，所以搜尋時也要用 trigram。
 * 例：「你上次說了甚麼笑話」→ [「你上次」,「上次說」,「次說了」,…,「麼笑話」]
 * 取最多 5 個 trigram（避免 query 太長），用 OR 連接。
 */
function extractCjkTrigrams(text: string, maxTrigrams = 5): string[] {
  // 提取連續 CJK 字元 runs
  const cjkRuns: string[] = []
  let current = ''
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) {
      current += ch
    } else {
      if (current.length >= MIN_FTS_QUERY_LEN) cjkRuns.push(current)
      current = ''
    }
  }
  if (current.length >= MIN_FTS_QUERY_LEN) cjkRuns.push(current)

  // 從每個 CJK run 提取 trigram
  const trigrams: string[] = []
  for (const run of cjkRuns) {
    for (let i = 0; i <= run.length - MIN_FTS_QUERY_LEN && trigrams.length < maxTrigrams; i++) {
      trigrams.push(run.slice(i, i + MIN_FTS_QUERY_LEN))
    }
  }
  return trigrams
}

/**
 * FTS5 query sanitizer — 改進版。
 *
 * 1. 按空白切 token，過濾 <3 char
 * 2. 對含 CJK 的長 token（無空格中文句子）提取 trigram sliding window
 * 3. 每段包 phrase literal `"..."`，用 OR 連接
 * 4. 全部 token 被過濾掉時回空字串
 */
function sanitizeFtsQuery(raw: string): string {
  const words = raw.trim().split(/\s+/)

  const ftsTokens: string[] = []

  for (const word of words) {
    if (word.length < MIN_FTS_QUERY_LEN) continue

    // 如果 word 含 CJK 且長度 > 3，拆成 trigram
    if (word.length > MIN_FTS_QUERY_LEN && CJK_REGEX.test(word)) {
      const trigrams = extractCjkTrigrams(word)
      ftsTokens.push(...trigrams)
    } else {
      ftsTokens.push(word)
    }
  }

  if (ftsTokens.length === 0) return ''
  return ftsTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function truncate(s: string, max = SNIPPET_MAX_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

// ── 主 export ───────────────────────────────────────────────────────

/**
 * 從文字中提取 CJK 2-char 子詞，用於 LIKE fallback。
 * 只取 CJK 字元組成的片段，每個取中間位置的 2-char window。
 * 回傳最多 maxKeywords 個不重複的 2-char 關鍵詞。
 */
function extractCjkKeywords(text: string, maxKeywords = 3): string[] {
  const runs: string[] = []
  let current = ''
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) {
      current += ch
    } else {
      if (current.length >= 2) runs.push(current)
      current = ''
    }
  }
  if (current.length >= 2) runs.push(current)

  const keywords = new Set<string>()
  for (const run of runs) {
    // 從 run 中取出所有 2-char window，優先保留靠後的（通常是名詞/動詞核心）
    for (let i = run.length - 2; i >= 0 && keywords.size < maxKeywords; i--) {
      keywords.add(run.slice(i, i + 2))
    }
  }
  return [...keywords]
}

/**
 * 搜尋 session 歷史中與 query 相關的對話片段。
 *
 * 策略：
 * 1. FTS5 trigram MATCH（≥3 char token）
 * 2. FTS 無結果時 → LIKE fallback 搜 sessions.first_user_message
 *    （用 CJK 2-char 關鍵詞 OR 匹配）
 *
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
  if (!query || query.trim().length < 2) return []

  try {
    await ensureReconciled(projectRoot)
  } catch {
    // reconcile 失敗不致命
  }

  try {
    const db = openSessionIndex(projectRoot)

    // ── 策略 1：FTS MATCH ──
    const ftsQuery = sanitizeFtsQuery(query)
    if (ftsQuery) {
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

      if (rows.length > 0) {
        return rows.map(r => ({
          sessionId: r.session_id,
          role: r.role,
          content: truncate(r.content),
          startedAt: r.started_at,
        }))
      }
    }

    // ── 策略 2：LIKE fallback（搜 session 標題 + 最近 assistant 訊息）──
    const cjkKeywords = extractCjkKeywords(query)
    // 也嘗試用空白切出的 ≥2 char 非 CJK tokens
    const plainTokens = query
      .trim()
      .split(/\s+/)
      .filter(t => t.length >= 2 && !CJK_REGEX.test(t[0]!))
      .slice(0, 3)
    const likeTerms = [...cjkKeywords, ...plainTokens]

    if (likeTerms.length === 0) return []

    // 搜 sessions.first_user_message
    const conditions = likeTerms.map(() => 'first_user_message LIKE ?').join(' OR ')
    const params = likeTerms.map(t => `%${t}%`)

    const sessionRows = db
      .query<
        { session_id: string; first_user_message: string | null; started_at: number },
        string[]
      >(
        `SELECT session_id, first_user_message, started_at
         FROM sessions
         WHERE ${conditions}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...params, String(limit))

    if (sessionRows.length > 0) {
      return sessionRows.map(r => ({
        sessionId: r.session_id,
        role: 'user',
        content: truncate(r.first_user_message ?? ''),
        startedAt: r.started_at,
      }))
    }

    return []
  } catch {
    // FTS parse 失敗或 DB 損毀 → 回空
    return []
  }
}
