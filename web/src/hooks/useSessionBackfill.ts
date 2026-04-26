/**
 * M-WEB-22：偵測 (projectId, sessionId) 變化 → 若 messageStore 沒此 session 的
 * 訊息（或被外部清空），fetch /api/.../messages → 轉成 UiMessage → 整段 backfill。
 *
 * 行為：
 *   - 同一 (proj, sid) 已 backfill 過、且 messages 仍存在 → skip 重抓
 *   - 切換到「真正空」的歷史 session（未 backfill）→ 觸發 fetch
 *   - active session：如果 store 裡已有 turn.event 增量上來的訊息，不會被覆蓋
 *     （因為 length > 0）；若整個 session 從未送過訊息（全新 session），仍會
 *     fetch 拿到空 array，set 成空 array — 沒副作用
 *   - loading / error 狀態寫進 sessionStore.loadingMessagesByProject /
 *     errorMessagesByProject，UI 顯示用
 */
import { useEffect } from 'react'
import { api, ApiError } from '../api/client'
import type { IndexedMessage } from '../api/types'
import { useMessageStore, type UiMessage, type ContentBlock } from '../store/messageStore'
import { useSessionStore } from '../store/sessionStore'

const MAX_BACKFILL = 100

/**
 * IndexedMessage（FTS5 row）轉 UiMessage（store 顯示用）。
 *
 * 取捨：
 *   - thinking / tool_use 完整 input 在 FTS 表沒存（schema 只有 content + 少量
 *     metadata）；歷史顯示走「最小可用」— text 直接拿、tool_name 有值的話補
 *     一個 stub tool_use 卡片（input: null）
 *   - role === 'system' 略過：通常是 daemon 內部訊息，UI 顯示出來會雜
 *   - 多個 IndexedMessage 同 messageIndex 不應該發生（FTS 主鍵）但保險用 set
 */
function indexedToUiMessage(m: IndexedMessage): UiMessage | null {
  if (m.role === 'system') return null
  const role = m.role === 'user' ? 'user' : 'assistant'
  const blocks: ContentBlock[] = []
  if (m.toolName) {
    blocks.push({
      kind: 'tool_use',
      toolUseID: `historical-${m.sessionId.slice(0, 8)}-${m.messageIndex}`,
      toolName: m.toolName,
      input: null,
      // 歷史 tool_use 沒辦法補回 result（FTS 沒存）；UI 顯示「(historical)」
    })
    if (m.content) {
      blocks.push({ kind: 'text', text: m.content })
    }
  } else {
    blocks.push({ kind: 'text', text: m.content })
  }
  return {
    id: `idx-${m.sessionId.slice(0, 8)}-${m.messageIndex}`,
    role,
    blocks,
    startedAt: m.timestamp,
    inputId: `historical-${m.messageIndex}`,
    inFlight: false,
  }
}

export function useSessionBackfill(
  projectId: string | null,
  sessionId: string | null,
): void {
  useEffect(() => {
    if (!projectId || !sessionId) return
    const ms = useMessageStore.getState()
    const ss = useSessionStore.getState()

    // 已有訊息 → skip（避免每次切回來都打 API 蓋掉 in-memory 狀態）
    const existing = ms.bySession[sessionId]
    if (existing && existing.length > 0) return

    // 已在 loading → skip（避免 race 重複 fetch）
    if (ss.loadingMessagesByProject[projectId]?.[sessionId]) return

    let cancelled = false
    ss.setMessagesLoading(projectId, sessionId, true)
    ss.setMessagesError(projectId, sessionId, null)

    api.messages
      .list(projectId, sessionId, { limit: MAX_BACKFILL })
      .then(({ messages }) => {
        if (cancelled) return
        const ui = messages
          .map(indexedToUiMessage)
          .filter((m): m is UiMessage => m !== null)
        useMessageStore.getState().backfillMessages(sessionId, ui)
        useSessionStore
          .getState()
          .setMessagesLoading(projectId, sessionId, false)
      })
      .catch(err => {
        if (cancelled) return
        const msg =
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err)
        useSessionStore.getState().setMessagesError(projectId, sessionId, msg)
        useSessionStore
          .getState()
          .setMessagesLoading(projectId, sessionId, false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])
}

// 對 test / debug 暴露轉換函式
export const _internalIndexedToUi = indexedToUiMessage
