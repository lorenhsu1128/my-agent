// M-LLAMACPP-GEMMA：packMessagesForGemma 與 translateRequestToOpenAI 整合測試。
// 覆蓋 6 種違規模式 + tool 定義併入 system + Qwen 不執行。

import { describe, expect, test } from 'bun:test'
import {
  packMessagesForGemma,
  translateRequestToOpenAI,
} from '../../../src/services/api/llamacpp-fetch-adapter.js'
import { GEMMA_TOK } from '../../../src/services/api/llamacpp-gemma-format.js'
import type { LlamaCppWatchdogConfig } from '../../../src/llamacppConfig/schema.js'

const Q = GEMMA_TOK.STR_DELIM
const NO_WATCHDOG: LlamaCppWatchdogConfig = {
  enabled: false,
  interChunk: { enabled: false, gapMs: 30_000 },
  reasoning: { enabled: false, blockMs: 120_000 },
  tokenCap: {
    enabled: false,
    default: 100_000,
    memoryPrefetch: 100_000,
    sideQuery: 100_000,
    background: 100_000,
  },
}

describe('packMessagesForGemma — 系統訊息合併與 tool 併入', () => {
  test('多筆 system 合併為單筆，順序保留', () => {
    const out = packMessagesForGemma(
      [
        { role: 'system', content: 'Sys A' },
        { role: 'system', content: 'Sys B' },
        { role: 'user', content: 'hi' },
      ],
      undefined,
    )
    expect(out[0].role).toBe('system')
    expect(out[0].content).toBe('Sys A\n\nSys B')
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('tools 經 renderToolDeclaration 併入 system 尾端', () => {
    const out = packMessagesForGemma(
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'go' },
      ],
      [
        {
          type: 'function',
          function: {
            name: 'Bash',
            description: 'run shell',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        },
      ],
    )
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('You are helpful.')
    expect(out[0].content).toContain(GEMMA_TOK.TOOL_OPEN + 'declaration:Bash')
    expect(out[0].content).toContain(GEMMA_TOK.TOOL_CLOSE)
    expect(out[0].content).toContain(`${Q}STRING${Q}`)
  })

  test('沒有 system 但有 tools → 自動建立 system message', () => {
    const out = packMessagesForGemma(
      [{ role: 'user', content: 'hi' }],
      [
        {
          type: 'function',
          function: {
            name: 'X',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    )
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('declaration:X')
  })
})

describe('packMessagesForGemma — tool_calls + tool 結果 packing', () => {
  test('assistant{tool_calls} + tool + assistant{text} → 單一 packed assistant', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'Tokyo weather' },
        {
          role: 'assistant',
          content: 'let me check',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: '{"temperature":15,"weather":"sunny"}',
        },
        { role: 'assistant', content: 'Tokyo is 15°C' },
      ],
      undefined,
    )
    // [user, packed-assistant]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ role: 'user', content: 'Tokyo weather' })
    expect(out[1].role).toBe('assistant')
    const c = out[1].content as string
    expect(c).toContain('let me check')
    expect(c).toContain(GEMMA_TOK.CALL_OPEN + 'call:get_weather')
    expect(c).toContain(`location:${Q}Tokyo${Q}`)
    expect(c).toContain(GEMMA_TOK.RESP_OPEN + 'response:get_weather')
    expect(c).toContain('temperature:15')
    expect(c).toContain(`weather:${Q}sunny${Q}`)
    expect(c).toContain('Tokyo is 15°C')
    // 不應該有 tool_calls / tool_call_id 殘留
    expect(out[1].tool_calls).toBeUndefined()
    expect(out[1].tool_call_id).toBeUndefined()
  })

  test('多個 tool_calls 與多個 tool 結果保持順序', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'A', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'B', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '"r1"' },
        { role: 'tool', tool_call_id: 'b', content: '{"r":2}' },
      ],
      undefined,
    )
    expect(out).toHaveLength(2)
    const c = out[1].content as string
    // 順序：call A → call B → response A → response B
    const idxCallA = c.indexOf('call:A')
    const idxCallB = c.indexOf('call:B')
    const idxRespA = c.indexOf('response:A')
    const idxRespB = c.indexOf('response:B')
    expect(idxCallA).toBeGreaterThanOrEqual(0)
    expect(idxCallA).toBeLessThan(idxCallB)
    expect(idxCallB).toBeLessThan(idxRespA)
    expect(idxRespA).toBeLessThan(idxRespB)
  })

  test('沒有後續 assistant{text} 也能 pack', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'X', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '"ok"' },
      ],
      undefined,
    )
    expect(out).toHaveLength(2)
    const c = out[1].content as string
    expect(c).toContain('call:X')
    expect(c).toContain('response:X')
  })
})

describe('packMessagesForGemma — 嚴格交替修正', () => {
  test('首個非 system 是 assistant → prepend (continue) user', () => {
    const out = packMessagesForGemma(
      [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'priming' },
        { role: 'user', content: 'hi' },
      ],
      undefined,
    )
    expect(out[0].role).toBe('system')
    expect(out[1]).toEqual({ role: 'user', content: '(continue)' })
    expect(out[2]).toEqual({ role: 'assistant', content: 'priming' })
    expect(out[3]).toEqual({ role: 'user', content: 'hi' })
  })

  test('連續兩個 user 訊息合併（文字）', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
      undefined,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ role: 'user', content: 'first\n\nsecond' })
  })

  test('連續兩個 assistant 合併（文字）', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'A' },
        { role: 'assistant', content: 'B' },
      ],
      undefined,
    )
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ role: 'assistant', content: 'AB' })
  })

  test('連續 user 含 image multipart 合併（image-first 順序）', () => {
    const out = packMessagesForGemma(
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG1' } },
            { type: 'text', text: 'desc1' },
          ],
        },
        { role: 'user', content: 'desc2' },
      ],
      undefined,
    )
    expect(out).toHaveLength(1)
    const parts = out[0].content as Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >
    // image 在前，text 在後
    expect(parts[0].type).toBe('image_url')
    const lastPart = parts[parts.length - 1]
    expect(lastPart.type).toBe('text')
    if (lastPart.type === 'text') {
      expect(lastPart.text).toContain('desc1')
      expect(lastPart.text).toContain('desc2')
    }
  })

  test('assistant content null → 補空字串', () => {
    const out = packMessagesForGemma(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null },
      ],
      undefined,
    )
    expect(out[1].content).toBe('')
  })
})

describe('translateRequestToOpenAI — Gemma 模型走 packing；Qwen 維持原行為', () => {
  test('Gemma：tools 移到 system，body.tools 被刪除', () => {
    const body = translateRequestToOpenAI(
      {
        model: 'gemopus-4-e4b',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { name: 'Bash', description: 'shell', input_schema: { type: 'object', properties: {} } },
        ],
      },
      'gemopus-4-e4b',
      { vision: false, watchdogCfg: NO_WATCHDOG },
    )
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain(GEMMA_TOK.TOOL_OPEN)
    expect(body.messages[0].content).toContain('declaration:Bash')
  })

  test('Qwen：tools 保留為 OpenAI 頂層欄位，不走 Gemma packing', () => {
    const body = translateRequestToOpenAI(
      {
        model: 'qwen3.5-9b-neo',
        system: 'sys',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'c1',
                name: 'X',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
            ],
          },
        ],
        tools: [
          { name: 'X', input_schema: { type: 'object', properties: {} } },
        ],
      },
      'qwen3.5-9b-neo',
      { vision: false, watchdogCfg: NO_WATCHDOG },
    )
    expect(body.tools).toBeDefined()
    expect(body.tools?.length).toBe(1)
    expect(body.tool_choice).toBe('auto')
    // system 不含 Gemma token
    expect(typeof body.messages[0].content === 'string'
      ? body.messages[0].content
      : '').not.toContain(GEMMA_TOK.TOOL_OPEN)
  })

  test('Gemma：完整 tool turn 序列正確 packed', () => {
    const body = translateRequestToOpenAI(
      {
        model: 'gemopus-4-e4b',
        system: 'sys',
        messages: [
          { role: 'user', content: 'Tokyo' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'looking up' },
              {
                type: 'tool_use',
                id: 'c1',
                name: 'get_weather',
                input: { location: 'Tokyo' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'c1',
                content: '{"temp":15}',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'weather',
            input_schema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      },
      'gemopus-4-e4b',
      { vision: false, watchdogCfg: NO_WATCHDOG },
    )
    // 訊息序列：[system, user, packed-assistant]
    expect(body.messages.length).toBeGreaterThanOrEqual(3)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Tokyo' })
    const last = body.messages[body.messages.length - 1]
    expect(last.role).toBe('assistant')
    const c = last.content as string
    expect(c).toContain('looking up')
    expect(c).toContain('call:get_weather')
    expect(c).toContain(`location:${Q}Tokyo${Q}`)
    expect(c).toContain('response:get_weather')
    expect(c).toContain('temp:15')
  })
})

describe('alternation invariant: 套用後 messages 真的交替 user/assistant', () => {
  test('tool turn 結束後 user/assistant 嚴格交替', () => {
    const body = translateRequestToOpenAI(
      {
        model: 'gemopus-4-e4b',
        system: 'sys',
        messages: [
          { role: 'user', content: 'a' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'c1',
                name: 'X',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
        tools: [{ name: 'X', input_schema: { type: 'object', properties: {} } }],
      },
      'gemopus-4-e4b',
      { vision: false, watchdogCfg: NO_WATCHDOG },
    )
    const nonSys = body.messages.filter(m => m.role !== 'system')
    for (let i = 0; i < nonSys.length; i++) {
      const expected = i % 2 === 0 ? 'user' : 'assistant'
      expect(nonSys[i].role).toBe(expected)
    }
  })
})
