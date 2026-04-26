/**
 * M-WEB per-session message state（zustand）。
 *
 * 設計（Phase 2 最小可用）：
 *   - 每 session 一份 UI message 陣列（按 turn 與 chunk 累加）
 *   - 收 turn.start → 建一筆 user message + 開新 assistant turn 容器
 *   - 收 turn.event 的 SDK message → append text/tool_use/thinking blocks 到當前
 *     assistant turn
 *   - 收 turn.end → 標記 turn 結束（用於 spinner）
 */
import { create } from 'zustand'

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; collapsed?: boolean }
  | {
      kind: 'tool_use'
      toolUseID: string
      toolName: string
      input: unknown
      result?: unknown
      resultIsError?: boolean
    }

export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  source?: string
  blocks: ContentBlock[]
  /** turn 是否仍在跑（spinner / streaming indicator）。 */
  inFlight?: boolean
  startedAt: number
  endedAt?: number
  /** 對應 input id（assistant 訊息會塞 turn.start 的 inputId）。 */
  inputId?: string
}

interface MessageState {
  /** sessionId → messages */
  bySession: Record<string, UiMessage[]>
  startUserTurn(
    sessionId: string,
    inputId: string,
    text: string,
    source?: string,
  ): void
  startAssistantTurn(
    sessionId: string,
    inputId: string,
    startedAt: number,
  ): void
  appendBlock(sessionId: string, inputId: string, block: ContentBlock): void
  appendTextDelta(
    sessionId: string,
    inputId: string,
    blockIndex: number,
    delta: string,
  ): void
  appendThinkingDelta(
    sessionId: string,
    inputId: string,
    blockIndex: number,
    delta: string,
  ): void
  setToolResult(
    sessionId: string,
    toolUseID: string,
    result: unknown,
    isError: boolean,
  ): void
  endTurn(sessionId: string, inputId: string, endedAt: number): void
  /** 切 session 時用：清掉某 session 的 in-flight 旗標（若 daemon 還在跑會自動同步）。 */
  clearSession(sessionId: string): void
}

function ensureArr(s: MessageState, sessionId: string): UiMessage[] {
  if (!s.bySession[sessionId]) s.bySession[sessionId] = []
  return s.bySession[sessionId]!
}

export const useMessageStore = create<MessageState>(set => ({
  bySession: {},
  startUserTurn: (sessionId, inputId, text, source) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      arr.push({
        id: `user-${inputId}`,
        role: 'user',
        source,
        inputId,
        blocks: [{ kind: 'text', text }],
        startedAt: Date.now(),
      })
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  startAssistantTurn: (sessionId, inputId, startedAt) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      // 防重：相同 inputId 已有 assistant 訊息就跳過
      if (arr.some(m => m.role === 'assistant' && m.inputId === inputId)) {
        return s
      }
      arr.push({
        id: `asst-${inputId}`,
        role: 'assistant',
        inputId,
        blocks: [],
        inFlight: true,
        startedAt,
      })
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  appendBlock: (sessionId, inputId, block) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      const idx = arr.findIndex(
        m => m.role === 'assistant' && m.inputId === inputId,
      )
      if (idx < 0) return s
      arr[idx] = { ...arr[idx]!, blocks: [...arr[idx]!.blocks, block] }
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  appendTextDelta: (sessionId, inputId, blockIndex, delta) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      const idx = arr.findIndex(
        m => m.role === 'assistant' && m.inputId === inputId,
      )
      if (idx < 0) return s
      const blocks = [...arr[idx]!.blocks]
      const b = blocks[blockIndex]
      if (!b || b.kind !== 'text') return s
      blocks[blockIndex] = { kind: 'text', text: b.text + delta }
      arr[idx] = { ...arr[idx]!, blocks }
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  appendThinkingDelta: (sessionId, inputId, blockIndex, delta) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      const idx = arr.findIndex(
        m => m.role === 'assistant' && m.inputId === inputId,
      )
      if (idx < 0) return s
      const blocks = [...arr[idx]!.blocks]
      const b = blocks[blockIndex]
      if (!b || b.kind !== 'thinking') return s
      blocks[blockIndex] = {
        kind: 'thinking',
        text: b.text + delta,
        collapsed: b.collapsed,
      }
      arr[idx] = { ...arr[idx]!, blocks }
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  setToolResult: (sessionId, toolUseID, result, isError) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      let changed = false
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i]!
        if (m.role !== 'assistant') continue
        const blocks = m.blocks.map(b => {
          if (b.kind === 'tool_use' && b.toolUseID === toolUseID) {
            changed = true
            return { ...b, result, resultIsError: isError }
          }
          return b
        })
        if (changed) {
          arr[i] = { ...m, blocks }
          break
        }
      }
      if (!changed) return s
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  endTurn: (sessionId, inputId, endedAt) =>
    set(s => {
      const arr = [...(s.bySession[sessionId] ?? [])]
      const idx = arr.findIndex(
        m => m.role === 'assistant' && m.inputId === inputId,
      )
      if (idx < 0) return s
      arr[idx] = { ...arr[idx]!, inFlight: false, endedAt }
      return { bySession: { ...s.bySession, [sessionId]: arr } }
    }),
  clearSession: sessionId =>
    set(s => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
}))

void ensureArr // 保留 helper（型別 reserved）
