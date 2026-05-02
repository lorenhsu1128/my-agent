/**
 * Gemma 4 SSE 響應端 streaming parser（M-LLAMACPP-GEMMA）
 *
 * 從 model 文字輸出中抽出 `<|tool_call>...<tool_call|>` token 序列，
 * 還原成 OpenAI 格式的 `tool_calls`（caller 再用既有路徑轉成 Anthropic
 * tool_use block）。`<|tool_response>...<tool_response|>` 視為歷史 echo
 * 略過不轉發。
 *
 * 設計理由與規格見 `docs/llamacpp-gemma-tool-format.md`。
 */

import {
  GEMMA_TOK,
  gemmaParse,
} from './llamacpp-gemma-format.js'

// ── 事件型別 ─────────────────────────────────────────────────────────────

export type GemmaStreamEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      args: Record<string, unknown>
      /** 原始 raw arguments 字串（給 Anthropic input_json_delta 用） */
      argsJson: string
    }

// ── 狀態機 ──────────────────────────────────────────────────────────────

type Mode = 'text' | 'in_call' | 'in_response'

/**
 * 未閉合 token 的安全上限：超過此 buffer 大小仍未遇到 close → 放棄解析，
 * 把整段 buffer 當純文字 emit 出去（避免吞訊息）。
 */
const MAX_UNCLOSED_BUFFER = 8192

/**
 * 為了避免 chunk 邊界把 token 切碎（例如 `<|tool` + `_call>`），
 * text mode 下保留尾端最多 N 字元延遲 emit，等下一個 chunk 接續判斷。
 */
const TAIL_HOLD = GEMMA_TOK.CALL_OPEN.length + GEMMA_TOK.RESP_OPEN.length

export interface GemmaToolCallExtractor {
  /**
   * 餵入一段新 chunk，回傳這段觸發的事件序列（可能 0 個或多個）。
   * 為避免 chunk 邊界切碎 token，text 結尾可能延遲到下一次 push 才 emit。
   */
  push(text: string): GemmaStreamEvent[]
  /** 把 buffer 裡剩餘的所有東西 flush 出去（stream 結束時呼叫）。 */
  flush(): GemmaStreamEvent[]
  /** 至今 emit 過幾次 tool_call（caller 統計用） */
  toolCallCount(): number
}

let _idCounter = 0
function mkCallId(): string {
  _idCounter = (_idCounter + 1) % 1_000_000
  return `call_gemma_${Date.now().toString(36)}_${_idCounter}`
}

/**
 * 建立有狀態的 extractor。每個 stream 用一個獨立 instance。
 */
export function createGemmaToolCallExtractor(): GemmaToolCallExtractor {
  let mode: Mode = 'text'
  let buf = ''   // text mode：尚未 emit 的尾巴；in_call/in_response：累積的內部 payload
  let toolCallCount = 0

  function processBuffer(out: GemmaStreamEvent[], isFlush: boolean): void {
    // 在 buf 上跑 state machine 直到無法再進展
    // 每輪只處理一個 transition / emit，迴圈直到 buffer 用盡或需等待更多輸入
    while (buf.length > 0) {
      if (mode === 'text') {
        // 在 text 中找 CALL_OPEN 或 RESP_OPEN
        const callIdx = buf.indexOf(GEMMA_TOK.CALL_OPEN)
        const respIdx = buf.indexOf(GEMMA_TOK.RESP_OPEN)
        const nextIdx =
          callIdx >= 0 && respIdx >= 0
            ? Math.min(callIdx, respIdx)
            : callIdx >= 0
              ? callIdx
              : respIdx
        if (nextIdx < 0) {
          // 沒看到任何 open token；emit 多數，留尾巴避免 token 跨 chunk 被切
          if (isFlush) {
            if (buf.length > 0) out.push({ type: 'text', text: buf })
            buf = ''
          } else if (buf.length > TAIL_HOLD) {
            const emitLen = buf.length - TAIL_HOLD
            out.push({ type: 'text', text: buf.slice(0, emitLen) })
            buf = buf.slice(emitLen)
            return
          } else {
            return
          }
          return
        }
        // emit 找到 open 之前的純文字
        if (nextIdx > 0) {
          out.push({ type: 'text', text: buf.slice(0, nextIdx) })
          buf = buf.slice(nextIdx)
        }
        // 進入對應 mode
        if (callIdx === nextIdx && callIdx >= 0) {
          mode = 'in_call'
          buf = buf.slice(GEMMA_TOK.CALL_OPEN.length)
        } else {
          mode = 'in_response'
          buf = buf.slice(GEMMA_TOK.RESP_OPEN.length)
        }
        continue
      }

      // in_call / in_response：找對應 close
      const closeTok =
        mode === 'in_call' ? GEMMA_TOK.CALL_CLOSE : GEMMA_TOK.RESP_CLOSE
      const closeIdx = buf.indexOf(closeTok)
      if (closeIdx < 0) {
        // 沒找到 close
        if (buf.length > MAX_UNCLOSED_BUFFER) {
          // fallback：吐成純文字，避免吞訊息（並標註異常）
          // biome-ignore lint/suspicious/noConsole:: loud diagnostic
          console.warn(
            `[gemma-stream-parser] unclosed ${mode === 'in_call' ? 'tool_call' : 'tool_response'} ` +
              `> ${MAX_UNCLOSED_BUFFER} chars，fallback 為文字。`,
          )
          const reopen =
            mode === 'in_call' ? GEMMA_TOK.CALL_OPEN : GEMMA_TOK.RESP_OPEN
          out.push({ type: 'text', text: reopen + buf })
          buf = ''
          mode = 'text'
        } else if (isFlush) {
          // 結束 flush 時還沒收 close → 同樣 fallback
          const reopen =
            mode === 'in_call' ? GEMMA_TOK.CALL_OPEN : GEMMA_TOK.RESP_OPEN
          out.push({ type: 'text', text: reopen + buf })
          buf = ''
          mode = 'text'
        }
        return
      }
      // 收到完整 payload
      const inner = buf.slice(0, closeIdx)
      buf = buf.slice(closeIdx + closeTok.length)

      if (mode === 'in_call') {
        const ev = parseCallPayload(inner)
        if (ev) {
          toolCallCount++
          out.push(ev)
        }
        // parse 失敗的話，inner 已被丟棄（記在 console，避免 confusing client）
      }
      // in_response：歷史 echo，整段丟棄不 emit
      mode = 'text'
      // 繼續迴圈處理 buffer 剩餘
    }
  }

  function parseCallPayload(inner: string): GemmaStreamEvent | null {
    // payload 結構：`call:NAME{args}` — NAME 後直接接 `{`
    const m = /^call:([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/s.exec(inner)
    if (!m) {
      // biome-ignore lint/suspicious/noConsole:: diagnostic
      console.warn(`[gemma-stream-parser] invalid tool_call payload: ${inner.slice(0, 80)}`)
      return null
    }
    const name = m[1]
    const argsRaw = m[2].trim()
    let args: Record<string, unknown> = {}
    let argsJson = '{}'
    if (argsRaw.length > 0) {
      try {
        const parsed = gemmaParse(argsRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else {
          args = { __raw__: parsed }
        }
        argsJson = JSON.stringify(args)
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole:: diagnostic
        console.warn(
          `[gemma-stream-parser] gemmaParse failed for ${name}: ${(err as Error).message}; ` +
            `raw=${argsRaw.slice(0, 80)}`,
        )
        args = { __raw__: argsRaw }
        argsJson = JSON.stringify(args)
      }
    }
    return {
      type: 'tool_call',
      id: mkCallId(),
      name,
      args,
      argsJson,
    }
  }

  return {
    push(text: string): GemmaStreamEvent[] {
      if (text.length === 0) return []
      buf += text
      const out: GemmaStreamEvent[] = []
      processBuffer(out, /* isFlush */ false)
      return out
    },
    flush(): GemmaStreamEvent[] {
      const out: GemmaStreamEvent[] = []
      processBuffer(out, /* isFlush */ true)
      return out
    },
    toolCallCount(): number {
      return toolCallCount
    },
  }
}

// ── 非 streaming 一次性版本 ─────────────────────────────────────────────

/**
 * 對非 streaming 完整文字一次性抽出所有 tool_call 與 stripped text。
 * `<|tool_response>...<tool_response|>` 同樣略過。
 *
 * 回傳：
 *  - text：剝除所有 tool_call / tool_response token 後的純文字
 *  - toolCalls：依序抽出的 tool call
 */
export function extractGemmaToolCalls(input: string): {
  text: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; argsJson: string }>
} {
  const ext = createGemmaToolCallExtractor()
  const events = [...ext.push(input), ...ext.flush()]
  const textParts: string[] = []
  const toolCalls: Array<{
    id: string
    name: string
    args: Record<string, unknown>
    argsJson: string
  }> = []
  for (const ev of events) {
    if (ev.type === 'text') textParts.push(ev.text)
    else
      toolCalls.push({
        id: ev.id,
        name: ev.name,
        args: ev.args,
        argsJson: ev.argsJson,
      })
  }
  return { text: textParts.join(''), toolCalls }
}
