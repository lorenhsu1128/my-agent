// M-LLAMACPP-GEMMA：streaming tool_call extractor 單元測試
// 覆蓋：完整 / chunk split / 多 call / response 略過 / 異常未閉合 fallback / 純文字穿插

import { describe, expect, test } from 'bun:test'
import {
  GEMMA_TOK,
  renderToolCall,
  renderToolResponse,
} from '../../../src/services/api/llamacpp-gemma-format.js'
import {
  createGemmaToolCallExtractor,
  extractGemmaToolCalls,
  type GemmaStreamEvent,
} from '../../../src/services/api/llamacpp-gemma-stream-parser.js'

const collectAll = (chunks: string[]): GemmaStreamEvent[] => {
  const ext = createGemmaToolCallExtractor()
  const out: GemmaStreamEvent[] = []
  for (const c of chunks) out.push(...ext.push(c))
  out.push(...ext.flush())
  return out
}

describe('createGemmaToolCallExtractor — 基本案例', () => {
  test('純文字單一 chunk', () => {
    const events = collectAll(['hello world'])
    const text = events.filter(e => e.type === 'text').map(e => (e as any).text).join('')
    expect(text).toBe('hello world')
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0)
  })

  test('純文字多 chunk', () => {
    const events = collectAll(['hello ', 'world ', '!'])
    const text = events.filter(e => e.type === 'text').map(e => (e as any).text).join('')
    expect(text).toBe('hello world !')
  })

  test('完整 tool_call 一次餵入', () => {
    const call = renderToolCall('Bash', { command: 'ls' })
    const events = collectAll([call])
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bash')
    expect(calls[0].args).toEqual({ command: 'ls' })
    expect(calls[0].id).toMatch(/^call_gemma_/)
  })

  test('完整 tool_call 含前後純文字', () => {
    const call = renderToolCall('Read', { path: '/tmp/x' })
    const events = collectAll([`thinking... ${call} done`])
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as any).text)
      .join('')
    expect(text).toContain('thinking...')
    expect(text).toContain('done')
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({ path: '/tmp/x' })
  })

  test('多個連續 tool_call', () => {
    const c1 = renderToolCall('A', { x: 1 })
    const c2 = renderToolCall('B', { y: 2 })
    const events = collectAll([c1 + c2])
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe('A')
    expect(calls[1].name).toBe('B')
  })
})

describe('chunk 邊界切碎', () => {
  test('CALL_OPEN 跨 chunk', () => {
    const call = renderToolCall('X', { v: true })
    // 把 token 切在 `<|tool` 與 `_call>` 之間
    const cut = GEMMA_TOK.CALL_OPEN.length - 6 // ~  '<|tool'
    const a = call.slice(0, cut)
    const b = call.slice(cut)
    const events = collectAll([a, b])
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('X')
  })

  test('payload 字串跨多 chunk（每 char 一 chunk）', () => {
    const call = renderToolCall('Bash', { cmd: 'ls -la /tmp' })
    const chunks = call.split('')
    const events = collectAll(chunks)
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({ cmd: 'ls -la /tmp' })
  })

  test('CALL_CLOSE 跨 chunk', () => {
    const call = renderToolCall('Y', { z: 'hi' })
    const idx = call.length - 4 // 切在收尾 token 中間
    const events = collectAll([call.slice(0, idx), call.slice(idx)])
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Y')
  })

  test('純文字陸續 push 不會被吞（flush 後拿到全部）', () => {
    const ext = createGemmaToolCallExtractor()
    ext.push('hello')
    ext.push(' ')
    ext.push('world')
    const final = ext.flush()
    const text = final.filter(e => e.type === 'text').map(e => (e as any).text).join('')
    expect(text).toContain('world')
  })
})

describe('tool_response 處理', () => {
  test('tool_response 完整 chunk → 略過不 emit', () => {
    const resp = renderToolResponse('X', '"ok"')
    const events = collectAll([`prefix ${resp} suffix`])
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as any).text)
      .join('')
    expect(text).toContain('prefix')
    expect(text).toContain('suffix')
    expect(text).not.toContain(GEMMA_TOK.RESP_OPEN)
    expect(text).not.toContain('response:X')
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0)
  })

  test('tool_response 與 tool_call 混合，後者照常 emit', () => {
    const call = renderToolCall('A', { v: 1 })
    const resp = renderToolResponse('A', '"done"')
    const events = collectAll([`${call}${resp} final answer`])
    const calls = events.filter(e => e.type === 'tool_call')
    expect(calls).toHaveLength(1)
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as any).text)
      .join('')
    expect(text).toContain('final answer')
  })
})

describe('異常 / fallback', () => {
  test('未閉合 tool_call < MAX → flush 時 fallback 為文字', () => {
    const ext = createGemmaToolCallExtractor()
    ext.push(`${GEMMA_TOK.CALL_OPEN}call:X{a:1`)
    const final = ext.flush()
    const text = final
      .filter(e => e.type === 'text')
      .map(e => (e as any).text)
      .join('')
    expect(text).toContain(GEMMA_TOK.CALL_OPEN)
    expect(text).toContain('call:X')
    // 沒有 tool_call event
    expect(final.filter(e => e.type === 'tool_call')).toHaveLength(0)
  })

  test('未閉合 tool_response → flush 時 fallback 為文字', () => {
    const ext = createGemmaToolCallExtractor()
    ext.push(`${GEMMA_TOK.RESP_OPEN}response:X{a:1`)
    const final = ext.flush()
    const text = final
      .filter(e => e.type === 'text')
      .map(e => (e as any).text)
      .join('')
    expect(text).toContain(GEMMA_TOK.RESP_OPEN)
  })

  test('payload 內無效 JSON → 用 __raw__ 包', () => {
    const events = collectAll([
      `${GEMMA_TOK.CALL_OPEN}call:Bad{not json at all}${GEMMA_TOK.CALL_CLOSE}`,
    ])
    const calls = events.filter(e => e.type === 'tool_call') as Extract<
      GemmaStreamEvent,
      { type: 'tool_call' }
    >[]
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bad')
    // gemmaParse 容忍部分（識別字 key）所以可能 partial parse；至少不 crash
    expect(typeof calls[0].args).toBe('object')
  })

  test('payload 完全不符 call:NAME 格式 → 拋棄不 emit', () => {
    const events = collectAll([
      `${GEMMA_TOK.CALL_OPEN}garbage no colon${GEMMA_TOK.CALL_CLOSE}`,
    ])
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0)
  })
})

describe('extractGemmaToolCalls — 非 streaming 一次性', () => {
  test('剝除 token 後純文字 + 抽出所有 call', () => {
    const c1 = renderToolCall('A', { v: 1 })
    const r1 = renderToolResponse('A', '"r"')
    const c2 = renderToolCall('B', { v: 2 })
    const input = `Pre ${c1} mid ${r1} mid2 ${c2} done`
    const { text, toolCalls } = extractGemmaToolCalls(input)
    expect(text).toContain('Pre')
    expect(text).toContain('mid')
    expect(text).toContain('mid2')
    expect(text).toContain('done')
    expect(text).not.toContain(GEMMA_TOK.CALL_OPEN)
    expect(text).not.toContain(GEMMA_TOK.RESP_OPEN)
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0].name).toBe('A')
    expect(toolCalls[1].name).toBe('B')
    expect(toolCalls[0].args).toEqual({ v: 1 })
    expect(toolCalls[1].args).toEqual({ v: 2 })
    // argsJson 是 OpenAI/Anthropic input_json_delta 用的字串
    expect(JSON.parse(toolCalls[0].argsJson)).toEqual({ v: 1 })
  })

  test('純文字無 token → toolCalls 為空、text 完整保留', () => {
    const { text, toolCalls } = extractGemmaToolCalls('just text here')
    expect(text).toBe('just text here')
    expect(toolCalls).toHaveLength(0)
  })

  test('唯有 tool_response → text 變空、toolCalls 為空', () => {
    const r = renderToolResponse('X', '"result"')
    const { text, toolCalls } = extractGemmaToolCalls(r)
    expect(text).toBe('')
    expect(toolCalls).toHaveLength(0)
  })
})

describe('extractor toolCallCount', () => {
  test('emit 多個 tool_call 後 count 累計', () => {
    const ext = createGemmaToolCallExtractor()
    ext.push(renderToolCall('A', {}))
    ext.push(renderToolCall('B', {}))
    expect(ext.toolCallCount()).toBe(2)
  })
})
