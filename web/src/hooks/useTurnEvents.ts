/**
 * M-WEB-11：把 WS turn.start / turn.event / turn.end 寫進 messageStore。
 *
 * 解析策略：
 *   1. e.event 一定是 daemon RunnerEvent wrapper：{type:'output', payload}
 *      / {type:'error', error} / {type:'done'}。我們只處理 'output'。
 *   2. payload 是 SDK message：
 *      - sdk.type === 'assistant' → final content；用 content blocks replace
 *        當前 assistant turn 的 blocks（canonical，避免與 stream delta 重複）
 *      - sdk.type === 'stream_event' → 增量 delta；text_delta / thinking_delta
 *        / input_json_delta 累加到對應 blockIndex 的 partial block
 *      - 其餘（user tool_result / system / result）暫時忽略
 *
 * 修復 bug（2026-04-26）：原本的 isSdkAssistant 對 RunnerEvent wrapper（`type='output'`）
 * 也回 true，於是直接抓 wrapper.message（不存在）→ 永遠 0 blocks → assistant
 * 訊息 UI 整片空白。改成先 strict 檢查 wrapper、再進 SDK 解析。
 */
import { useEffect } from 'react'
import type { ServerEvent } from '../api/types'
import { useMessageStore, type ContentBlock } from '../store/messageStore'
import type { WsClient } from '../api/ws'

interface SdkContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string
  text?: string
  thinking?: string
  id?: string // tool_use
  name?: string // tool_use
  input?: unknown // tool_use
  tool_use_id?: string // tool_result
  content?: unknown // tool_result
  is_error?: boolean // tool_result
}

interface SdkAssistantMessage {
  type: 'assistant'
  message?: {
    role: 'assistant'
    content: SdkContentBlock[] | string
  }
}

interface SdkStreamEvent {
  type: 'stream_event'
  event?: {
    type: string
    index?: number
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
    }
    content_block?: {
      type: 'text' | 'thinking' | 'tool_use'
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
    }
  }
}

interface RunnerOutputEvent {
  type: 'output'
  payload?: unknown
}

function isRunnerOutput(e: unknown): e is RunnerOutputEvent {
  if (!e || typeof e !== 'object') return false
  return (e as { type?: unknown }).type === 'output'
}

function isAssistantSdk(p: unknown): p is SdkAssistantMessage {
  if (!p || typeof p !== 'object') return false
  return (p as { type?: unknown }).type === 'assistant'
}

function isStreamSdk(p: unknown): p is SdkStreamEvent {
  if (!p || typeof p !== 'object') return false
  return (p as { type?: unknown }).type === 'stream_event'
}

function extractBlocksFromAssistant(msg: SdkAssistantMessage): {
  blocks: ContentBlock[]
  toolResults: { toolUseID: string; result: unknown; isError: boolean }[]
} {
  const blocks: ContentBlock[] = []
  const toolResults: {
    toolUseID: string
    result: unknown
    isError: boolean
  }[] = []
  const content = msg.message?.content
  if (typeof content === 'string') {
    blocks.push({ kind: 'text', text: content })
    return { blocks, toolResults }
  }
  if (!Array.isArray(content)) return { blocks, toolResults }
  for (const c of content) {
    if (c.type === 'text' && typeof c.text === 'string') {
      blocks.push({ kind: 'text', text: c.text })
    } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
      blocks.push({ kind: 'thinking', text: c.thinking, collapsed: true })
    } else if (c.type === 'tool_use' && typeof c.id === 'string') {
      blocks.push({
        kind: 'tool_use',
        toolUseID: c.id,
        toolName: c.name ?? '(unknown tool)',
        input: c.input,
      })
    } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      toolResults.push({
        toolUseID: c.tool_use_id,
        result: c.content,
        isError: c.is_error === true,
      })
    }
  }
  return { blocks, toolResults }
}

/**
 * 把 stream_event delta 套到 messageStore 的 assistant turn 上。
 * Anthropic stream protocol：content_block_start → content_block_delta… → content_block_stop。
 * 我們在 start 時 append 一個空 block，delta 時用 appendTextDelta /
 * appendThinkingDelta 累加。
 */
function applyStreamEvent(
  sessionId: string,
  inputId: string,
  ev: SdkStreamEvent['event'],
): void {
  if (!ev) return
  const store = useMessageStore.getState()
  if (ev.type === 'content_block_start' && ev.content_block) {
    const cb = ev.content_block
    if (cb.type === 'text') {
      store.appendBlock(sessionId, inputId, {
        kind: 'text',
        text: cb.text ?? '',
      })
    } else if (cb.type === 'thinking') {
      store.appendBlock(sessionId, inputId, {
        kind: 'thinking',
        text: cb.thinking ?? '',
        collapsed: false,
      })
    } else if (cb.type === 'tool_use' && typeof cb.id === 'string') {
      store.appendBlock(sessionId, inputId, {
        kind: 'tool_use',
        toolUseID: cb.id,
        toolName: cb.name ?? '(unknown tool)',
        input: cb.input,
      })
    }
    return
  }
  if (ev.type === 'content_block_delta' && ev.delta && ev.index !== undefined) {
    const dt = ev.delta.type
    if (dt === 'text_delta' && typeof ev.delta.text === 'string') {
      store.appendTextDelta(sessionId, inputId, ev.index, ev.delta.text)
    } else if (
      dt === 'thinking_delta' &&
      typeof ev.delta.thinking === 'string'
    ) {
      store.appendThinkingDelta(sessionId, inputId, ev.index, ev.delta.thinking)
    }
    // input_json_delta（tool_use input 串流）暫時忽略 — 等 tool_use_complete
    // 或 final assistant 時用完整 input 蓋過去
    return
  }
  // content_block_stop / message_start / message_delta / message_stop 不需處理
}

/**
 * 用 final assistant 的 content blocks 取代當前 turn 的 blocks（canonical）。
 * 這避免 stream delta 累加結果與 final 重複。
 */
function replaceAssistantBlocks(
  sessionId: string,
  inputId: string,
  blocks: ContentBlock[],
): void {
  const store = useMessageStore.getState()
  // 找該 turn → 把 blocks 直接 set
  const arr = store.bySession[sessionId] ?? []
  const idx = arr.findIndex(
    m => m.role === 'assistant' && m.inputId === inputId,
  )
  if (idx < 0) return
  // 直接用 zustand 的 setState 改 — 走 set callback
  useMessageStore.setState(s => {
    const list = [...(s.bySession[sessionId] ?? [])]
    const i = list.findIndex(
      m => m.role === 'assistant' && m.inputId === inputId,
    )
    if (i < 0) return s
    list[i] = { ...list[i]!, blocks }
    return { bySession: { ...s.bySession, [sessionId]: list } }
  })
}

export function useTurnEvents(
  ws: WsClient | null,
  sessionId: string | null,
  projectId: string | null,
): void {
  useEffect(() => {
    if (!ws || !sessionId || !projectId) return
    const store = useMessageStore.getState()

    const off = ws.on('frame', (e: ServerEvent) => {
      if (
        !('projectId' in e) ||
        (e as { projectId?: string }).projectId !== projectId
      ) {
        return
      }
      switch (e.type) {
        case 'turn.start':
          store.startAssistantTurn(sessionId, e.inputId, e.startedAt)
          break

        case 'turn.event': {
          // 1. 必須是 RunnerEvent wrapper {type:'output', payload}
          if (!isRunnerOutput(e.event)) return
          const payload = (e.event as RunnerOutputEvent).payload
          // 2. SDK message
          if (isStreamSdk(payload)) {
            applyStreamEvent(sessionId, e.inputId, payload.event)
            return
          }
          if (isAssistantSdk(payload)) {
            const { blocks, toolResults } = extractBlocksFromAssistant(payload)
            // canonical replace（與 stream delta 結果對齊；deltas 已建立部分 blocks
            // 但 final 帶完整內容含 server-side normalized text，直接 replace 最穩）
            if (blocks.length > 0) {
              replaceAssistantBlocks(sessionId, e.inputId, blocks)
            }
            for (const tr of toolResults) {
              store.setToolResult(
                sessionId,
                tr.toolUseID,
                tr.result,
                tr.isError,
              )
            }
            return
          }
          // user tool_result / system / result 等暫不處理
          return
        }

        case 'turn.end':
          store.endTurn(sessionId, e.inputId, e.endedAt)
          break

        default:
          break
      }
    })
    return off
  }, [ws, sessionId, projectId])
}
