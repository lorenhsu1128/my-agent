/**
 * M2-03：Session index bulk reconciler。
 *
 * 啟動時（或第一次 SessionSearchTool 呼叫時）掃描當前 project 的 JSONL transcripts，
 * 把未索引 / 已修改過的 session 補進 FTS。
 *
 * 設計要點：
 * - 讀取 `{CLAUDE_CONFIG_HOME}/projects/{slug}/*.jsonl`（注意：主 session 檔在 projectDir
 *   直接層，不在 `conversations/` 子目錄 — 那是文件措辭舊）
 * - 用 mtime 比對 `sessions.last_indexed_at`；相等或較新就跳過
 * - 逐行 parse 丟 `indexEntry`；shadow dedup 會自動處理重複
 * - 完成後更新 `sessions.last_indexed_at = mtime`
 * - 錯誤計數但不中斷；最終 log 一行 stats（stderr）
 *
 * Idempotent：`ensureReconciled(projectRoot)` 每個 projectRoot 只跑一次（Promise
 * cache）— 重複呼叫回傳同一個 in-flight / resolved Promise。
 *
 * Agent sidechain 檔（`{sessionId}/subagents/*.jsonl`）本階段**不**索引（與 M2-02 tee
 * 行為一致）。
 */
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { openSessionIndex } from './db.js'
import { indexEntry } from './indexWriter.js'

export interface ReconcileStats {
  sessionsScanned: number
  sessionsIndexed: number // session file 被讀取並處理（vs. 跳過 up-to-date）
  newSessions: number // 原本不在 index 的 session
  messagesIndexed: number // 實際產生 messages_fts INSERT 的行數（dedup 後）
  errors: number
  durationMs: number
}

const inflight = new Map<string, Promise<ReconcileStats>>()

/**
 * 冪等：同一 projectRoot 只跑一次。返回 in-flight / resolved Promise。
 *
 * 呼叫點：
 * - `src/setup.ts` 啟動 background jobs 區塊（fire-and-forget）
 * - `src/tools/SessionSearchTool/*`（M2-05 預計，await 以確保索引最新）
 */
export function ensureReconciled(projectRoot: string): Promise<ReconcileStats> {
  let p = inflight.get(projectRoot)
  if (!p) {
    p = reconcileProjectIndex(projectRoot)
    inflight.set(projectRoot, p)
  }
  return p
}

/** Test-only：重設冪等快取，讓 smoke 能多次呼叫。 */
export function _resetReconcileCacheForTest(): void {
  inflight.clear()
}

/**
 * 執行一次完整掃描（不加冪等快取）。一般呼叫者應走 `ensureReconciled`。
 */
export async function reconcileProjectIndex(
  projectRoot: string,
): Promise<ReconcileStats> {
  const startTime = Date.now()
  const stats: ReconcileStats = {
    sessionsScanned: 0,
    sessionsIndexed: 0,
    newSessions: 0,
    messagesIndexed: 0,
    errors: 0,
    durationMs: 0,
  }

  const projectDir = getProjectDir(projectRoot)

  let files: string[]
  try {
    const dirents = await readdir(projectDir, { withFileTypes: true })
    // 只要 projectDir 直接層的 .jsonl，不遞迴 subagents/
    files = dirents
      .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
      .map(d => d.name)
  } catch {
    // 目錄不存在（fresh install / 還沒對話過）— 正常情境，不算錯
    stats.durationMs = Date.now() - startTime
    logReconcileStats(projectDir, stats)
    return stats
  }

  const db = openSessionIndex(projectRoot)

  for (const filename of files) {
    stats.sessionsScanned++
    const jsonlPath = join(projectDir, filename)
    const sessionId = filename.replace(/\.jsonl$/, '')

    try {
      const st = await stat(jsonlPath)
      const mtime = Math.floor(st.mtimeMs)

      const existing = db
        .query<{ last_indexed_at: number | null }, [string]>(
          'SELECT last_indexed_at FROM sessions WHERE session_id = ?',
        )
        .get(sessionId)

      if (
        existing?.last_indexed_at !== null &&
        existing?.last_indexed_at !== undefined &&
        existing.last_indexed_at >= mtime
      ) {
        continue // up-to-date
      }

      const wasNew = existing === null

      // 記錄掃描前的 FTS 列數，之後用差值算 messagesIndexed
      const beforeCount = countFtsRowsForSession(db, sessionId)

      const text = await Bun.file(jsonlPath).text()
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as {
            type?: string
            uuid?: string
            sessionId?: string
            isSidechain?: boolean
            agentId?: string
            message?: unknown
          }
          // 檔名 session_id 為主；若 entry 有自帶且不同（resume 等情境）走 entry 的
          const sid = entry.sessionId ?? sessionId
          // Sidechain 檔單獨寫在 subagents/；但保險起見，若這個 entry 標了
          // isSidechain，也跳過（與 M2-02 tee 行為一致）
          if (entry.isSidechain) continue
          indexEntry(
            entry as Parameters<typeof indexEntry>[0],
            sid,
            projectRoot,
          )
        } catch {
          // 這一行壞掉（JSON parse 失敗）— 計進 errors，繼續下一行
          stats.errors++
        }
      }

      const afterCount = countFtsRowsForSession(db, sessionId)
      stats.messagesIndexed += afterCount - beforeCount

      // 更新 last_indexed_at；若 session 本來不存在，indexEntry 會建 row，這裡 UPDATE 一定有 row
      db.query('UPDATE sessions SET last_indexed_at = ? WHERE session_id = ?').run(
        mtime,
        sessionId,
      )

      stats.sessionsIndexed++
      if (wasNew) stats.newSessions++
    } catch (err) {
      stats.errors++
      // 單一 session 失敗不影響其他
      void err
    }
  }

  stats.durationMs = Date.now() - startTime
  logReconcileStats(projectDir, stats)
  return stats
}

function countFtsRowsForSession(
  db: ReturnType<typeof openSessionIndex>,
  sessionId: string,
): number {
  const row = db
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(sessionId)
  return row?.c ?? 0
}

function logReconcileStats(projectDir: string, stats: ReconcileStats): void {
  // 只在有東西變動 或 有錯誤 時 log；完全靜止時保持沉默避免雜訊
  if (
    stats.sessionsIndexed === 0 &&
    stats.messagesIndexed === 0 &&
    stats.errors === 0 &&
    stats.sessionsScanned === 0
  ) {
    return
  }
  const parts = [
    `掃 ${stats.sessionsScanned} 個 session`,
    `索引 ${stats.sessionsIndexed}（${stats.newSessions} 新）`,
    `寫入 ${stats.messagesIndexed} 筆訊息`,
  ]
  if (stats.errors > 0) parts.push(`${stats.errors} 筆錯誤`)
  parts.push(`耗時 ${stats.durationMs}ms`)
  // biome-ignore lint/suspicious/noConsole: 一次性啟動摘要
  console.warn(`[sessionIndex] 啟動掃描完成：${parts.join('，')}`)
}
