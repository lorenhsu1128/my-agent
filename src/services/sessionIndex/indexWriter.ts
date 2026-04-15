/**
 * M2-02：將 session JSONL 寫入同步 tee 到 SQLite FTS 索引。
 *
 * 設計約束（不可妥協）：
 * - JSONL 仍是 source of truth；索引只是衍生快取
 * - Tee 失敗**絕對不能**中斷主寫入流程 → 整個 indexEntry 被 try/catch 包住
 * - SQLITE_BUSY 直接吞掉，不重試、不等鎖（避免卡主執行緒）；M2-03 bulk
 *   indexer 會補回漏寫
 *
 * 呼叫方：`src/utils/sessionStorage.ts:appendEntry`（TranscriptMessage 分支）
 * 呼叫時需傳 `getProjectRoot()` 作 projectRoot 參數 — **不是** `getOriginalCwd()`，
 * 後者會在 EnterWorktreeTool 被改動，導致索引分裂。
 */
import { openSessionIndex } from './db.js'

/**
 * 呼叫方應傳入的 entry 形狀（不 import SessionStorage 內部型別，避免循環依賴）。
 * 對應 `src/utils/sessionStorage.ts` 的 TranscriptMessage。
 */
interface TranscriptEntry {
  type: string
  uuid?: string
  message?: {
    role?: string
    content?: string | readonly ContentBlock[]
    stop_reason?: string
  }
}

interface ContentBlock {
  type: string
  // text block
  text?: string
  // thinking block
  thinking?: string
  // tool_use block
  name?: string
  input?: unknown
  // tool_result block
  content?: string | readonly ContentBlock[]
}

const MESSAGE_BEARING_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])

function isMessageBearingType(type: string): boolean {
  return MESSAGE_BEARING_TYPES.has(type)
}

/**
 * SQLite 的 SQLITE_BUSY（code 5）/ SQLITE_LOCKED（code 6）識別。
 * bun:sqlite 拋出的 Error 帶 `code` 屬性。
 */
function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true
  // 保險：某些 bun 版本 code 可能塞在 message
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(err.message)
}

let loggedGenericError = false
function logIndexError(err: unknown): void {
  if (loggedGenericError) return // 每程序只 log 一次，避免洗版
  loggedGenericError = true
  const msg = err instanceof Error ? err.message : String(err)
  // biome-ignore lint/suspicious/noConsole: indexer 非致命錯誤提示
  console.warn(`[sessionIndex] tee 寫入失敗（本 session 後續錯誤不再 log）：${msg}`)
}

/**
 * 從訊息 entry 取可搜尋文字。擴充 `src/utils/messages.ts:getContentText`：
 * 除 text block 外，也把 tool_use input、tool_result content、thinking 展開進 FTS。
 */
function extractSearchableContent(entry: TranscriptEntry): string {
  const message = entry.message
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(block.thinking)
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool:${block.name}] ${JSON.stringify(block.input)}`)
    } else if (block.type === 'tool_result') {
      const rc = block.content
      if (typeof rc === 'string') {
        parts.push(rc)
      } else if (Array.isArray(rc)) {
        for (const b of rc) {
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        }
      }
    }
  }
  return parts.join('\n').trim()
}

/** 若訊息含 tool_use block，回工具名；否則 null。 */
function extractToolName(entry: TranscriptEntry): string | null {
  const content = entry.message?.content
  if (!Array.isArray(content)) return null
  const toolUse = content.find(b => b.type === 'tool_use')
  return toolUse && typeof toolUse.name === 'string' ? toolUse.name : null
}

/**
 * 把一筆 entry 同步索引到 SQLite（sessions + messages_fts + messages_seen）。
 *
 * **必須由呼叫方傳穩定的 projectRoot**（`getProjectRoot()`，不是 `getOriginalCwd()`）。
 * 否則 session 中途進 worktree 會讓索引分裂。
 *
 * 所有錯誤吞掉；回傳 void。呼叫時不需 `await`、不需 try/catch。
 */
export function indexEntry(
  entry: TranscriptEntry,
  sessionId: string,
  projectRoot: string,
): void {
  try {
    if (!isMessageBearingType(entry.type)) return
    if (!entry.uuid) return // 防呆：訊息本應都帶 uuid

    const db = openSessionIndex(projectRoot)

    // Shadow 表去重 — 已存在 → changes=0 → 跳過後續 FTS 與 sessions 更新
    const seen = db
      .query('INSERT OR IGNORE INTO messages_seen (session_id, uuid) VALUES (?, ?)')
      .run(sessionId, entry.uuid)
    if (seen.changes === 0) return

    const content = extractSearchableContent(entry)
    if (!content) return // 空內容不寫（attachment-only 之類）

    const now = Date.now()
    const role = entry.message?.role ?? entry.type
    const toolName = extractToolName(entry)
    const finishReason = entry.message?.stop_reason ?? null

    // sessions 上插 — started_at / first_user_message 只在首次 INSERT 設定
    db.query(
      `INSERT INTO sessions (session_id, started_at, ended_at, first_user_message, message_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         ended_at = excluded.ended_at,
         message_count = sessions.message_count + 1,
         first_user_message = COALESCE(sessions.first_user_message, excluded.first_user_message)`,
    ).run(
      sessionId,
      now,
      now,
      entry.type === 'user' ? content.slice(0, 200) : null,
    )

    // message_index 取更新後的 message_count（= 當前 entry 在 session 中的序號）
    const row = db
      .query<{ message_count: number }, [string]>(
        'SELECT message_count FROM sessions WHERE session_id = ?',
      )
      .get(sessionId)

    db.query(
      `INSERT INTO messages_fts (session_id, message_index, role, timestamp, tool_name, finish_reason, content)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      row?.message_count ?? 0,
      role,
      now,
      toolName,
      finishReason,
      content,
    )
  } catch (err) {
    if (isSqliteBusy(err)) return // 多程序競爭時丟，M2-03 bulk indexer 補
    logIndexError(err)
  }
}

// Test-only：重設錯誤 log flag，讓 smoke 測多個錯誤案例時都能看到 log。
export function _resetIndexErrorLogFlagForTest(): void {
  loggedGenericError = false
}
