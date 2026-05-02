/**
 * Session-scoped memory recall 觀察 log（M-MEMRECALL-CMD）
 *
 * 每次 query-driven memory prefetch（`findRelevantMemories.ts`）命中一個 memory 檔，
 * 寫一筆到此 in-process Map。`/memory-recall` TUI 與 Web MemoryRecallTab 從這裡
 * 拉清單顯示「本 session 命中過的 memory」。
 *
 * 為什麼不持久化：
 *  - process exit 後 sessionId 已失效；長期歷史走 session log / transcript
 *  - 寫硬碟會引入 IO 與 race condition，這個資訊只在「使用者好奇」當下有用
 *
 * 為什麼用 sessionId 隔離：
 *  - daemon 模式同一 process 服務多 project / 多 client；不能讓 A 的 recall 出現在 B
 *  - 沒 sessionId（CLI -p 一次性模式）走 `'default'` 桶，反正用完就 exit
 */

export type RecallSource = 'selector' | 'fallback'

export interface RecallLogEntry {
  /** 記憶體檔絕對路徑 */
  path: string
  /** 第一次命中的 epoch ms（後續 hit 不更新此值，要看新鮮度看 hitCount） */
  ts: number
  /** 累計命中次數（同一 session 內多輪 query 命中同一檔會 ++） */
  hitCount: number
  /** 來自 selector LLM 還是 fallback（讓 UI 標示「fallback 路徑」） */
  source: RecallSource
}

const log = new Map<string, Map<string, RecallLogEntry>>()

/**
 * 記錄一次 recall 命中。同一 session + 同一 path 重複呼叫 → hitCount++ 與
 * source 取最新（fallback 蓋掉 selector，反映最新狀態）。
 */
export function recordRecall(
  sessionId: string,
  path: string,
  source: RecallSource,
): void {
  if (!sessionId || !path) return
  let bySession = log.get(sessionId)
  if (!bySession) {
    bySession = new Map()
    log.set(sessionId, bySession)
  }
  const existing = bySession.get(path)
  if (existing) {
    existing.hitCount += 1
    existing.source = source
  } else {
    bySession.set(path, {
      path,
      ts: Date.now(),
      hitCount: 1,
      source,
    })
  }
}

/**
 * 列當前 session 已命中的 memory 檔，依 ts desc（新到舊）排。
 */
export function listRecall(sessionId: string): RecallLogEntry[] {
  const bySession = log.get(sessionId)
  if (!bySession) return []
  return [...bySession.values()].sort((a, b) => b.ts - a.ts)
}

/**
 * 清空指定 session 的 log。/memory-recall 提供一個「reset」按鈕用。
 */
export function clearRecall(sessionId: string): void {
  log.delete(sessionId)
}

/**
 * 測試 / debug 用：完全清空所有 session。
 */
export function _clearAllForTesting(): void {
  log.clear()
}
