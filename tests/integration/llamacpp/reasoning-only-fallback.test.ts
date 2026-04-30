/**
 * M-QWEN35-RENDER regression：reasoning-only stream（只 reasoning_content、
 * 沒 content、沒 tool_calls）必須在 stream 收尾時補一個 text block，把
 * thinking 內容鏡射過去；否則 QueryEngine.ts:1156 的 `last(content).type`
 * 提取會落空，cli `-p` headless 模式 stdout 空白。
 *
 * 觸發場景：Qwen3.5 thinking 模式把答案塞到 reasoning_content；或推理用完
 * max_tokens budget content 被 server 過濾成空字串。
 */
import { describe, expect, test } from 'bun:test'
import { translateOpenAIStreamToAnthropic } from '../../../src/services/api/llamacpp-fetch-adapter'

// 把字串陣列包成 SSE 風格的 ReadableStream<Uint8Array>，模擬 llama-server
function makeMockSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const lines: string[] = []
  for (const ev of events) {
    lines.push(`data: ${JSON.stringify(ev)}\n\n`)
  }
  lines.push('data: [DONE]\n\n')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
}

async function collect(
  gen: AsyncGenerator<string>,
): Promise<{ events: string[]; raw: string }> {
  const events: string[] = []
  let raw = ''
  for await (const ch of gen) {
    raw += ch
    events.push(ch)
  }
  return { events, raw }
}

describe('translateOpenAIStreamToAnthropic — reasoning-only fallback', () => {
  test('reasoning_content 滿、content 空、無 tool_call → 收尾補 text block', async () => {
    const events = [
      // 開頭 chunk
      {
        id: 'cmpl-1',
        choices: [{ index: 0, delta: { reasoning_content: 'Thinking part 1. ' } }],
      },
      {
        id: 'cmpl-1',
        choices: [{ index: 0, delta: { reasoning_content: 'Final answer: Red.' } }],
      },
      // finish_reason
      {
        id: 'cmpl-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      },
    ]
    const stream = makeMockSseStream(events)
    const { raw } = await collect(translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'test-msg-id'))

    // 必須有一個 thinking_delta 塊
    expect(raw).toContain('"thinking_delta"')
    expect(raw).toContain('Thinking part 1.')

    // 關鍵：必須在尾巴補一個 text_delta，內容含累積的 thinking 全文
    // （兩段 reasoning_content 會 concat）
    const textDeltaMatches = raw.match(/"text_delta"/g)
    expect(textDeltaMatches?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(raw).toContain('Final answer: Red.')

    // 末尾 message_stop 必須存在
    expect(raw).toContain('message_stop')
  })

  test('content 有值（非 reasoning-only）→ 不觸發 fallback', async () => {
    const events = [
      {
        id: 'cmpl-2',
        choices: [{ index: 0, delta: { reasoning_content: 'Brief thinking. ' } }],
      },
      {
        id: 'cmpl-2',
        choices: [{ index: 0, delta: { content: 'Red' } }],
      },
      {
        id: 'cmpl-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    ]
    const stream = makeMockSseStream(events)
    const { raw } = await collect(translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'test-msg-id-2'))

    // 應有正常 text_delta 'Red'
    expect(raw).toContain('"text_delta"')
    expect(raw).toContain('Red')

    // 但 'Brief thinking.' 不應出現在任何 text_delta（只能在 thinking_delta）
    const textDeltas = [...raw.matchAll(/"text_delta","text":"([^"]*)"/g)].map(m => m[1])
    for (const t of textDeltas) {
      expect(t).not.toContain('Brief thinking')
    }
  })

  test('有 tool_call → 即使無 content 也不觸發 fallback', async () => {
    const events = [
      {
        id: 'cmpl-3',
        choices: [{ index: 0, delta: { reasoning_content: 'I will use a tool.' } }],
      },
      {
        id: 'cmpl-3',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"path":"/tmp/x"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'cmpl-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      },
    ]
    const stream = makeMockSseStream(events)
    const { raw } = await collect(translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'test-msg-id-3'))

    // 'I will use a tool.' 不可被當 fallback 灌進 text_delta
    const textDeltas = [...raw.matchAll(/"text_delta","text":"([^"]*)"/g)].map(m => m[1])
    for (const t of textDeltas) {
      expect(t).not.toContain('I will use a tool')
    }

    // 必須有 tool_use 區塊（content_block_start with tool_use）
    expect(raw).toContain('"tool_use"')
  })
})
