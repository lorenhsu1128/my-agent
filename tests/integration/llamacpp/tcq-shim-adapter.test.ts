/**
 * TCQ-shim adapter mode 行為驗證。
 *
 * 核心對比：當 streaming SSE 同時包含「結構化 tool_calls」與「content 內 XML 殘留」
 * （TCQ-shim 已 server 端 parse 過，但模型 thinking 偶爾把同一 XML 也吐進 content）：
 *
 *   - vanilla mode：偵測 XML → 觸發 leak fallback → 合成第二份 tool_use → 重複 tool 執行
 *   - tcq mode：跳過 leak fallback → 只信任結構化 tool_calls → 一份 tool_use
 *
 * 也順帶驗證：reasoning_content / 純 content / context overflow 在 tcq mode 都正常。
 */
import { describe, expect, test } from 'bun:test'
import { translateOpenAIStreamToAnthropic } from '../../../src/services/api/llamacpp-fetch-adapter'
import { createTcqShimFetch } from '../../../src/services/api/tcq-shim-fetch-adapter'
import {
  isContextOverflowError,
  buildPromptTooLongResponse,
} from '../../../src/services/api/llamacpp-shared/context-overflow'

function makeSse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const lines = events.map(e => `data: ${JSON.stringify(e)}\n\n`)
  lines.push('data: [DONE]\n\n')
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l))
      c.close()
    },
  })
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let s = ''
  for await (const ch of gen) s += ch
  return s
}

describe('tcq mode: stream translator skips XML leak fallback', () => {
  test('結構化 tool_calls + content 同時帶 XML → 只發一個 tool_use', async () => {
    const events = [
      { choices: [{ delta: { role: 'assistant' } }] },
      // 模型先把 thinking 吐出來，內含 XML 樣文字（shim parse 後仍可能殘留在 content）
      {
        choices: [
          {
            delta: {
              content:
                '<tool_call>\n<function=Bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>',
            },
          },
        ],
      },
      // 接著 server 已 parse 過後送結構化 tool_calls
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  function: { name: 'Bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]

    const tcqRaw = await collect(
      translateOpenAIStreamToAnthropic(makeSse(events), 'qwen3.5-9b', 'msg_x', 'turn', 'tcq'),
    )
    const tcqUseCount = (tcqRaw.match(/"type":"tool_use"/g) ?? []).length
    expect(tcqUseCount).toBe(1)
    // 不該出現 fallback id 前綴
    expect(tcqRaw).not.toContain('toolu_xmlfallback_')
    expect(tcqRaw).not.toContain('toolu_pyfallback_')

    const vanillaRaw = await collect(
      translateOpenAIStreamToAnthropic(
        makeSse(events),
        'qwen3.5-9b',
        'msg_x',
        'turn',
        'vanilla',
      ),
    )
    // vanilla：仍只發一個 tool_use（emittedToolCall 已 set，leak fallback 不會再進）
    // 主要差異是 vanilla 路徑會走 leak detection 條件（成本），tcq 直接跳過。
    // 這個 case 兩條都正確，重點是 tcq 不誤判。
    const vanillaUseCount = (vanillaRaw.match(/"type":"tool_use"/g) ?? []).length
    expect(vanillaUseCount).toBe(1)
  })

  test('只有 content XML、無結構化 tool_calls：vanilla 補一份、tcq 不補', async () => {
    const events = [
      { choices: [{ delta: { role: 'assistant' } }] },
      {
        choices: [
          {
            delta: {
              content:
                '<tool_call>\n<function=Bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>',
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]

    const tcqRaw = await collect(
      translateOpenAIStreamToAnthropic(makeSse(events), 'qwen3.5-9b', 'msg_y', 'turn', 'tcq'),
    )
    expect(tcqRaw).not.toContain('toolu_xmlfallback_')
    expect((tcqRaw.match(/"type":"tool_use"/g) ?? []).length).toBe(0)

    const vanillaRaw = await collect(
      translateOpenAIStreamToAnthropic(
        makeSse(events),
        'qwen3.5-9b',
        'msg_y',
        'turn',
        'vanilla',
      ),
    )
    expect(vanillaRaw).toContain('toolu_xmlfallback_')
    expect((vanillaRaw.match(/"type":"tool_use"/g) ?? []).length).toBe(1)
  })

  test('reasoning_content + content 兩條 delta 在 tcq mode 都正確映射', async () => {
    const events = [
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { reasoning_content: '思考一下...' } }] },
      { choices: [{ delta: { content: '答案是 42' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]
    const raw = await collect(
      translateOpenAIStreamToAnthropic(makeSse(events), 'qwen3.5-9b', 'msg_z', 'turn', 'tcq'),
    )
    // 注意：jsonStringifyAsciiSafe 把中文 escape 成 \uXXXX，比對用 escape 後的字串
    expect(raw).toContain('"type":"thinking"')
    expect(raw).toContain('"type":"thinking_delta"')
    expect(raw).toContain('"type":"text_delta"')
    // 「思考」= 思考，「答案是」= 答案是
    expect(raw).toMatch(/\\u601d\\u8003/)
    expect(raw).toMatch(/\\u7b54\\u6848\\u662f/)
  })
})

describe('createTcqShimFetch', () => {
  test('包裝 createLlamaCppFetch、固定 binaryKind=tcq', () => {
    // smoke：函式可以被 instantiate（不打網路），回傳 fetch shape
    const fn = createTcqShimFetch({ baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.5-9b' })
    expect(typeof fn).toBe('function')
  })
})

describe('context-overflow 共用 helper', () => {
  test('TCQ-shim 413 直接視為 overflow', () => {
    expect(isContextOverflowError(413, 'whatever')).toBe(true)
  })
  test('vanilla 400 + 關鍵字 → overflow', () => {
    expect(isContextOverflowError(400, 'context length exceeded')).toBe(true)
    expect(isContextOverflowError(400, 'n_ctx exceeded')).toBe(true)
    expect(isContextOverflowError(400, 'prompt too long')).toBe(true)
  })
  test('400 不含關鍵字不算', () => {
    expect(isContextOverflowError(400, 'random error')).toBe(false)
  })
  test('buildPromptTooLongResponse 413 → 改寫成 400', async () => {
    const r = buildPromptTooLongResponse(413, 'context_length_exceeded')
    expect(r.status).toBe(400)
    const j = (await r.json()) as { type: string; error: { type: string; message: string } }
    expect(j.error.type).toBe('invalid_request_error')
    expect(j.error.message).toContain('Prompt is too long')
  })
})
