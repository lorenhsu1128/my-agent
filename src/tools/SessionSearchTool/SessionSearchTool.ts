/**
 * M2-05：SessionSearchTool — 跨 session 的 FTS 搜尋工具。
 *
 * 輸入 query / limit / summarize，回傳按 session 分組的 top-K 片段。
 *
 * 核心流程：
 * 1. 驗證 query；<3 char 的 trigram 限制 fallback 到 LIKE（掃 sessions.first_user_message）
 * 2. await ensureReconciled(projectRoot)：確保索引最新（啟動掃描若還在跑也會等）
 * 3. sanitize query（FTS5 MATCH 保留字 . " 等需包在 phrase literal 內）
 * 4. 查 messages_fts JOIN sessions，取 top-K 結果
 * 5. 按 session_id 分組，output 轉成 markdown 呈現給 LLM
 *
 * `summarize: true` 本階段接受但不作摘要，輸出附 `summaryPending: true` flag，
 * LLM 看到這個 flag 就知道 M2-06 尚未落地。
 */
import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  ensureReconciled,
  openSessionIndex,
} from '../../services/sessionIndex/index.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { DESCRIPTION, SESSION_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .describe(
        'Keyword or phrase to search across past conversation transcripts. Should be ≥3 characters (FTS5 trigram limit). Short CJK words (2 chars) auto-fall-back to title LIKE search.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max number of matching message snippets to return. Default 5.'),
    summarize: z
      .boolean()
      .optional()
      .describe(
        'If true, request an LLM-generated summary of the matches (future capability). M2-05 returns raw snippets with summaryPending: true.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const matchSchema = z.object({
  role: z.string(),
  tool_name: z.string().nullable(),
  snippet: z.string(),
  message_index: z.number(),
})

const sessionGroupSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  model: z.string().nullable(),
  message_count: z.number(),
  matches: z.array(matchSchema),
})

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string(),
    usedFallback: z
      .boolean()
      .describe(
        'true if query was <3 chars and we fell back to LIKE on first_user_message',
      ),
    totalMatches: z
      .number()
      .describe('Total rows matching query (may exceed limit)'),
    returnedMatches: z.number().describe('Matches returned after limit'),
    sessions: z.array(sessionGroupSchema),
    summaryPending: z.boolean().optional(),
    note: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN_FTS_QUERY_LEN = 3
const DEFAULT_LIMIT = 5
const SNIPPET_MAX_CHARS = 400

/**
 * FTS5 MATCH 的 reserved 字元（. " * ^ 等）在一般 tokens 裡會讓 parser 抱怨。
 * 把 query 按空白切，每段用 phrase literal `"..."` 包起來，AND join — 對大多數
 * 情境已足夠。Phrase 內的 " 用 "" escape。
 */
function sanitizeFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ')
}

interface RawMatch {
  session_id: string
  message_index: number
  role: string
  tool_name: string | null
  content: string
}

interface SessionMeta {
  session_id: string
  started_at: number
  ended_at: number | null
  model: string | null
  message_count: number
  first_user_message: string | null
}

function truncateSnippet(s: string, max = SNIPPET_MAX_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function makeTitle(firstUserMessage: string | null, sessionId: string): string {
  if (firstUserMessage && firstUserMessage.trim()) {
    return truncateSnippet(firstUserMessage.trim(), 80)
  }
  return `(無首訊息的 session ${sessionId.slice(0, 8)}…)`
}

function formatDate(ms: number): string {
  // 本地時間 ISO-ish，方便 LLM 讀
  const d = new Date(ms)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const SessionSearchTool = buildTool({
  name: SESSION_SEARCH_TOOL_NAME,
  searchHint: '搜尋過往對話 session 的 FTS 索引',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `搜尋過往對話：${summary}` : '搜尋過往對話'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  async validateInput({ query }): Promise<ValidationResult> {
    if (!query || !query.trim()) {
      return {
        result: false,
        message: 'query 不能為空字串',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(): Promise<PermissionDecision> {
    // 純讀本地索引；不涉及檔案系統權限或網路
    return { behavior: 'allow', updatedInput: {} as never }
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ sessions }) {
    // 回傳所有 snippet 串起來，方便全局搜尋
    return sessions
      .flatMap(s => s.matches.map(m => m.snippet))
      .join('\n')
  },
  async call(input) {
    const query = input.query.trim()
    const limit = input.limit ?? DEFAULT_LIMIT
    const summarize = input.summarize ?? false

    const projectRoot = getProjectRoot()

    // 確保索引最新（啟動掃描若還在跑會 await 同一 Promise）
    try {
      await ensureReconciled(projectRoot)
    } catch {
      // reconcile 失敗不致命 — 繼續用現有索引搜
    }

    const db = openSessionIndex(projectRoot)

    let usedFallback = false
    let rawMatches: RawMatch[] = []
    let totalMatches = 0

    if (query.length < MIN_FTS_QUERY_LEN) {
      // fallback：掃 sessions.first_user_message 的 LIKE
      usedFallback = true
      const pattern = `%${query.replace(/[%_\\]/g, c => '\\' + c)}%`
      const rows = db
        .query<
          { session_id: string; first_user_message: string | null },
          [string]
        >(
          `SELECT session_id, first_user_message FROM sessions
           WHERE first_user_message LIKE ? ESCAPE '\\'
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(pattern, limit as unknown as string)
      totalMatches = rows.length
      rawMatches = rows.map(r => ({
        session_id: r.session_id,
        message_index: 0,
        role: 'user',
        tool_name: null,
        content: r.first_user_message ?? '',
      }))
    } else {
      // FTS 路徑
      const ftsQuery = sanitizeFtsQuery(query)
      try {
        // 先算總數（可能 > limit）
        const countRow = db
          .query<{ c: number }, [string]>(
            'SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH ?',
          )
          .get(ftsQuery)
        totalMatches = countRow?.c ?? 0

        const rows = db
          .query<
            {
              session_id: string
              message_index: number
              role: string
              tool_name: string | null
              content: string
            },
            [string, number]
          >(
            `SELECT session_id, message_index, role, tool_name, content
             FROM messages_fts
             WHERE messages_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(ftsQuery, limit)
        rawMatches = rows
      } catch (err) {
        // sanitize 理論上能擋掉 syntax error，但保險：FTS parse 失敗就回空結果
        return {
          data: {
            query,
            usedFallback: false,
            totalMatches: 0,
            returnedMatches: 0,
            sessions: [],
            note: `FTS 查詢解析失敗：${err instanceof Error ? err.message : String(err)}`,
          } satisfies Output,
        }
      }
    }

    // 抓所有命中 session 的 metadata
    const sessionIds = Array.from(new Set(rawMatches.map(r => r.session_id)))
    const metaMap = new Map<string, SessionMeta>()
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(',')
      const metaRows = db
        .query<SessionMeta, string[]>(
          `SELECT session_id, started_at, ended_at, model, message_count, first_user_message
           FROM sessions WHERE session_id IN (${placeholders})`,
        )
        .all(...sessionIds)
      for (const m of metaRows) metaMap.set(m.session_id, m)
    }

    // 分組 by session，保留原 rank 順序（first match 先）
    const sessionOrder: string[] = []
    const byMatch = new Map<string, RawMatch[]>()
    for (const m of rawMatches) {
      if (!byMatch.has(m.session_id)) {
        byMatch.set(m.session_id, [])
        sessionOrder.push(m.session_id)
      }
      byMatch.get(m.session_id)!.push(m)
    }

    const sessions = sessionOrder.map(sid => {
      const meta = metaMap.get(sid)
      const matches = byMatch.get(sid)!
      return {
        session_id: sid,
        title: makeTitle(meta?.first_user_message ?? null, sid),
        started_at: meta?.started_at ?? 0,
        ended_at: meta?.ended_at ?? null,
        model: meta?.model ?? null,
        message_count: meta?.message_count ?? 0,
        matches: matches.map(m => ({
          role: m.role,
          tool_name: m.tool_name,
          snippet: truncateSnippet(m.content),
          message_index: m.message_index,
        })),
      }
    })

    const output: Output = {
      query,
      usedFallback,
      totalMatches,
      returnedMatches: rawMatches.length,
      sessions,
    }
    if (summarize) {
      output.summaryPending = true
      output.note =
        '摘要功能尚未落地（待 M2-06 實作）；目前回傳原始片段。'
    }

    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.sessions.length === 0) {
      const msg = output.usedFallback
        ? `未找到任何 session 標題含 "${output.query}"。可試試用更完整的詞彙（FTS5 trigram 需 ≥3 字元）。`
        : `未找到符合 "${output.query}" 的歷史對話。`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: msg,
      }
    }

    const lines: string[] = []
    const header = output.usedFallback
      ? `查詢 "${output.query}" <3 字元，已 fallback 為 session 標題 LIKE 搜尋。`
      : `找到 ${output.returnedMatches}/${output.totalMatches} 筆匹配（跨 ${output.sessions.length} 個 session）。`
    lines.push(header)
    if (output.note) lines.push(output.note)
    lines.push('')

    for (const s of output.sessions) {
      const dateStr = formatDate(s.started_at)
      const modelStr = s.model ? `, model=${s.model}` : ''
      lines.push(
        `## [${s.session_id.slice(0, 8)}] ${s.title}  (${dateStr}${modelStr}, ${s.message_count} 則訊息)`,
      )
      for (const m of s.matches) {
        const toolStr = m.tool_name ? ` tool=${m.tool_name}` : ''
        const singleLine = m.snippet.replace(/\n+/g, ' ↵ ')
        lines.push(`- [${m.role}${toolStr}] ${singleLine}`)
      }
      lines.push('')
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n').trimEnd(),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
