/**
 * M-WEB-11：把 WS turn.start / turn.event / turn.end 寫進 messageStore。
 *
 * 解析策略（Phase 2 最小集合）：
 *   - turn.event 的 payload 來自 daemon RunnerEvent；通常是
 *     `{ type: 'output', payload: <SDKMessage> }`
 *   - SDKMessage 對 assistant content 走 content[].type ∈ {text, thinking,
 *     tool_use, tool_result}；M-DAEMON-STREAM 後也會含 stream_event delta
 *   - 我們只展示完整 content blocks（文字 / thinking / tool_use；tool_result
 *     會找前一個 tool_use 並 attach 結果）
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

interface SdkMessage {
  type: string
  message?: {
    role: 'user' | 'assistant'
    content: SdkContentBlock[] | string
  }
  // stream events (delta) shape varies; we ignore in Phase 2
}

function isSdkAssistant(payload: unknown): payload is SdkMessage {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as { type?: unknown }
  return typeof p.type === 'string'
}

function extractBlocksFromSdk(msg: SdkMessage): {
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

export function useTurnEvents(
  ws: WsClient | null,
  sessionId: string | null,
  projectId: string | null,
): void {
  useEffect(() => {
    if (!ws || !sessionId || !projectId) return
    const store = useMessageStore.getState()

    const off = ws.on('frame', (e: ServerEvent) => {
      if (!('projectId' in e) || (e as { projectId?: string }).projectId !== projectId) {
        return
      }
      switch (e.type) {
        case 'turn.start': {
          // 把 user input 顯示出來：daemon 已記錄 inputText 到 input 內
          // 但 turn.start frame 沒帶；先用 placeholder（後續 inbound web input 會自己
          // 在送之前 append user message 到 store）。
          store.startAssistantTurn(sessionId, e.inputId, e.startedAt)
          break
        }
        case 'turn.event': {
          if (!isSdkAssistant(e.event)) {
            // 也許是 RunnerEvent.output → 解 payload
            const wrapper = e.event as { type?: string; payload?: unknown }
            if (
              wrapper &&
              wrapper.type === 'output' &&
              isSdkAssistant(wrapper.payload)
            ) {
              const { blocks, toolResults } = extractBlocksFromSdk(
                wrapper.payload,
              )
              for (const b of blocks)
                store.appendBlock(sessionId, e.inputId, b)
              for (const tr of toolResults)
                store.setToolResult(
                  sessionId,
                  tr.toolUseID,
                  tr.result,
                  tr.isError,
                )
            }
            return
          }
          const { blocks, toolResults } = extractBlocksFromSdk(e.event)
          for (const b of blocks) store.appendBlock(sessionId, e.inputId, b)
          for (const tr of toolResults)
            store.setToolResult(
              sessionId,
              tr.toolUseID,
              tr.result,
              tr.isError,
            )
          break
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
