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
import { getAnthropicClient } from '../../services/api/client.js'
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
  summary: z
    .string()
    .optional()
    .describe('LLM 產生的摘要（summarize=true 且成功時）'),
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
// M2-06：Summarization helper
// ---------------------------------------------------------------------------

/**
 * char budget for prompt input（char-based heuristic）：
 *   8K tokens × 3 chars/token ≈ 24,000 chars（中英混合保守估計）
 * 模型 ctx 32K，留給 prompt 其他部分與 response（max_tokens 2000）充裕 margin。
 */
const SUMMARIZE_MAX_INPUT_CHARS = 24_000
const SUMMARIZE_MAX_OUTPUT_TOKENS = 2000
const SUMMARIZE_TIMEOUT_MS = 30_000

type SummarizableSession = {
  session_id: string
  title: string
  started_at: number
  matches: Array<{
    role: string
    tool_name: string | null
    snippet: string
  }>
}

/**
 * 建 summarize prompt（繁中，嚴格 `## [id8]` 輸出格式）。
 * 若 session 片段太長會截斷，保留至少每 session 前 2 筆 match。
 * 回傳 `{ prompt, includedSessionIds }` — 有實際納入 prompt 的 sessions。
 */
function buildSummarizePrompt(
  sessions: SummarizableSession[],
  query: string,
  maxChars: number,
): { prompt: string; includedSessionIds: string[] } {
  const header =
    `以下是使用者查詢「${query}」在 ${sessions.length} 個過往對話 session 找到的相關片段。\n` +
    `請用**繁體中文**為每個 session 寫 1-3 句話的摘要，提煉對話的核心結論或脈絡；\n` +
    `不要複製片段原文。\n\n` +
    `嚴格遵守輸出格式（每個 session 一段、以 ## 開頭、session_id 前 8 碼標記）：\n\n` +
    `## [session_id 前 8 碼]\n` +
    `<你的摘要文字>\n\n` +
    `Sessions：\n\n`

  const included: string[] = []
  const parts: string[] = [header]
  let total = header.length

  for (const s of sessions) {
    const id8 = s.session_id.slice(0, 8)
    const sessHeader = `### [${id8}] ${s.title} (${formatDate(s.started_at)})\n`
    // 先試至少放 session header + 前 2 筆片段
    const reservedMatches = s.matches.slice(0, 2)
    const firstBlock =
      sessHeader +
      reservedMatches
        .map(
          m =>
            `- [${m.role}${m.tool_name ? ` tool=${m.tool_name}` : ''}] ${m.snippet.replace(/\n+/g, ' ↵ ').slice(0, 300)}`,
        )
        .join('\n') +
      '\n\n'
    if (total + firstBlock.length > maxChars) break // 沒空間了
    parts.push(firstBlock)
    total += firstBlock.length
    included.push(s.session_id)

    // 剩餘 matches 能塞就塞
    for (const m of s.matches.slice(2)) {
      const line = `- [${m.role}${m.tool_name ? ` tool=${m.tool_name}` : ''}] ${m.snippet.replace(/\n+/g, ' ↵ ').slice(0, 300)}\n`
      if (total + line.length > maxChars) {
        parts.push(`- …（還有 ${s.matches.length - 2} 筆略）\n\n`)
        break
      }
      parts.push(line)
      total += line.length
    }
  }

  return { prompt: parts.join(''), includedSessionIds: included }
}

/**
 * 解析 LLM 回應（預期 `## [id8]\nsummary\n\n## [id8]\nsummary` 結構）。
 * 解析失敗時把整段當 fallback 放到第一個 session，其餘留空（呼叫端會 set summaryPending）。
 */
function parseSummaryResponse(
  text: string,
  sessionIdsInOrder: string[],
): Map<string, string> {
  const result = new Map<string, string>()
  // 以 `^## [` 切區塊（保留 `##`）
  const blocks = text.split(/\n(?=## \[)/)
  for (const block of blocks) {
    const m = block.match(/^##\s*\[([a-f0-9]+)\]?\s*\n?([\s\S]*?)$/m)
    if (!m) continue
    const id8 = m[1]!
    const summary = (m[2] ?? '').trim()
    if (!summary) continue
    // 找對應的 session_id（前 8 碼匹配）
    const full = sessionIdsInOrder.find(sid => sid.startsWith(id8))
    if (full && !result.has(full)) result.set(full, summary)
  }
  // 一筆都解析不到時 — 當作單一 summary 貼到第一個 session
  if (result.size === 0 && sessionIdsInOrder.length > 0 && text.trim()) {
    result.set(sessionIdsInOrder[0]!, text.trim())
  }
  return result
}

/**
 * 呼叫主模型（llamacpp）對命中片段做摘要。
 *
 * 返回 Map<session_id, summary_text>；失敗 / timeout / connection error / parse
 * 完全失敗都回 null，呼叫端 fallback 到原片段。絕不拋錯。
 */
async function summarizeSessions(
  sessions: SummarizableSession[],
  query: string,
  model: string,
  parentAbort: AbortController,
): Promise<Map<string, string> | null> {
  if (sessions.length === 0) return new Map()

  const { prompt, includedSessionIds } = buildSummarizePrompt(
    sessions,
    query,
    SUMMARIZE_MAX_INPUT_CHARS,
  )
  if (includedSessionIds.length === 0) return null

  const childCtrl = new AbortController()
  const propagateAbort = () => childCtrl.abort()
  if (parentAbort.signal.aborted) childCtrl.abort()
  else parentAbort.signal.addEventListener('abort', propagateAbort)

  const timer = setTimeout(() => childCtrl.abort(), SUMMARIZE_TIMEOUT_MS)

  try {
    const client = await getAnthropicClient()
    const resp = await client.messages.create(
      {
        model,
        max_tokens: SUMMARIZE_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: childCtrl.signal },
    )

    // 聚合 text content blocks
    const textParts: string[] = []
    for (const block of resp.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      }
    }
    const fullText = textParts.join('\n').trim()
    if (!fullText) return null

    return parseSummaryResponse(fullText, includedSessionIds)
  } catch {
    // 超時 / 連線 / context overflow / 其他 — 全部 graceful fallback
    return null
  } finally {
    clearTimeout(timer)
    parentAbort.signal.removeEventListener('abort', propagateAbort)
  }
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
  async call(input, context) {
    // Debug：若 input 形狀異常（例如 qwen 的 tool_call arguments 解析問題），先 log
    if (typeof input?.query !== 'string') {
      // biome-ignore lint/suspicious/noConsole: 診斷 tool input 形狀
      console.warn(
        `[SessionSearch] input.query 不是 string，實際 input =`,
        JSON.stringify(input),
      )
      return {
        data: {
          query: String(input?.query ?? ''),
          usedFallback: false,
          totalMatches: 0,
          returnedMatches: 0,
          sessions: [],
          note: `tool input 格式異常：query 應為 string，收到 ${typeof input?.query}。可能是模型 tool_call arguments 解析問題。`,
        } satisfies Output,
      }
    }
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

    // M2-06：summarize 分支 — 呼叫主模型（llamacpp）做摘要；失敗 graceful fallback
    if (summarize && output.sessions.length > 0) {
      const model = context.options.mainLoopModel
      const summaries = await summarizeSessions(
        output.sessions,
        query,
        model,
        context.abortController,
      )
      if (summaries && summaries.size > 0) {
        for (const s of output.sessions) {
          const sum = summaries.get(s.session_id)
          if (sum) s.summary = sum
        }
        const missing = output.sessions.filter(s => !s.summary).length
        if (missing > 0) {
          output.summaryPending = true
          output.note = `${missing} 個 session 的摘要解析失敗，顯示原片段。`
        }
      } else {
        output.summaryPending = true
        output.note =
          '摘要失敗（llamacpp 超時 / 不可用 / context overflow），顯示原片段。'
      }
    } else if (summarize && output.sessions.length === 0) {
      // 沒結果時 summarize 不做事，避免呼叫 LLM 浪費
      output.summaryPending = false
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
      if (s.summary) {
        // 有 summary：顯示摘要，不列 raw matches（M2-06）
        lines.push(s.summary)
      } else {
        // 沒 summary（summarize=false 或摘要失敗）：沿用 M2-05 raw matches
        for (const m of s.matches) {
          const toolStr = m.tool_name ? ` tool=${m.tool_name}` : ''
          const singleLine = m.snippet.replace(/\n+/g, ' ↵ ')
          lines.push(`- [${m.role}${toolStr}] ${singleLine}`)
        }
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
