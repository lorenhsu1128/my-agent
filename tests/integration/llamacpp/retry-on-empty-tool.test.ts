/**
 * 階段 3b — retry-on-empty-tool：observeSseChunk 判定 + RETRY_TOOL_NUDGE 內容。
 *
 * 驗證 streamWithRetryOnEmptyTool 核心偵測邏輯：第一輪 streaming 結束後若
 * state = { text=true, toolCall=false, stopReason='end_turn' } 代表模型走了
 * text-only 分支、需 retry。
 */
import { describe, expect, test } from 'bun:test'
import {
  RETRY_TOOL_NUDGE,
  observeSseChunk,
} from '../../../src/services/api/llamacpp-fetch-adapter'

type State = { text: boolean; toolCall: boolean; stopReason: string | null }

function freshState(): State {
  return { text: false, toolCall: false, stopReason: null }
}

describe('observeSseChunk', () => {
  test('text_delta → state.text=true', () => {
    const s = freshState()
    observeSseChunk(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      s,
    )
    expect(s.text).toBe(true)
    expect(s.toolCall).toBe(false)
  })

  test('input_json_delta → state.toolCall=true', () => {
    const s = freshState()
    observeSseChunk(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}\n\n',
      s,
    )
    expect(s.toolCall).toBe(true)
  })

  test('content_block_start with tool_use → state.toolCall=true', () => {
    const s = freshState()
    observeSseChunk(
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"x","name":"Bash","input":{}}}\n\n',
      s,
    )
    expect(s.toolCall).toBe(true)
  })

  test('message_delta stop_reason 被抽出', () => {
    const s = freshState()
    observeSseChunk(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
      s,
    )
    expect(s.stopReason).toBe('end_turn')
  })

  test('message_delta stop_reason=tool_use 被抽出', () => {
    const s = freshState()
    observeSseChunk(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}\n\n',
      s,
    )
    expect(s.stopReason).toBe('tool_use')
  })

  test('多個 chunk 累積 state', () => {
    const s = freshState()
    observeSseChunk(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\n',
      s,
    )
    observeSseChunk(
      'event: content_block_start\ndata: {"content_block":{"type":"tool_use"}}\n\n',
      s,
    )
    observeSseChunk(
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n',
      s,
    )
    expect(s.text).toBe(true)
    expect(s.toolCall).toBe(true)
    expect(s.stopReason).toBe('tool_use')
  })

  test('純 message_start / content_block_stop chunk 不改狀態', () => {
    const s = freshState()
    observeSseChunk('event: message_start\ndata: {"type":"message_start"}\n\n', s)
    observeSseChunk(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      s,
    )
    expect(s).toEqual({ text: false, toolCall: false, stopReason: null })
  })
})

describe('RETRY_TOOL_NUDGE 內容', () => {
  test('包含關鍵指令', () => {
    expect(RETRY_TOOL_NUDGE).toContain('tool_use')
    expect(RETRY_TOOL_NUDGE).toContain('MUST')
  })
})

// 判定邏輯（實際 retry 條件）測試
describe('retry 觸發判定', () => {
  const shouldRetry = (s: State) =>
    s.stopReason === 'end_turn' && s.text && !s.toolCall

  test('text + end_turn + 無 tool_use → 觸發 retry', () => {
    expect(shouldRetry({ text: true, toolCall: false, stopReason: 'end_turn' })).toBe(
      true,
    )
  })

  test('text + tool_use + end_turn → 不觸發（已呼叫工具）', () => {
    expect(shouldRetry({ text: true, toolCall: true, stopReason: 'end_turn' })).toBe(
      false,
    )
  })

  test('text + stop_reason=tool_use → 不觸發', () => {
    expect(shouldRetry({ text: true, toolCall: false, stopReason: 'tool_use' })).toBe(
      false,
    )
  })

  test('空 response + end_turn → 不觸發（連 text 都沒有，不算「光說不做」）', () => {
    expect(
      shouldRetry({ text: false, toolCall: false, stopReason: 'end_turn' }),
    ).toBe(false)
  })

  test('text + stop_reason=max_tokens → 不觸發（截斷情境，retry 也不會改善）', () => {
    expect(
      shouldRetry({ text: true, toolCall: false, stopReason: 'max_tokens' }),
    ).toBe(false)
  })
})
