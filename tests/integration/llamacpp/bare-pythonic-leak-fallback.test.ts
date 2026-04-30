/**
 * Bare pythonic tool-call leak fallback：Qwen3.5-9b 走 `tools` 路徑時偶發
 * 直接吐 bare pythonic 格式（無 <tool_call> 包外層、可能無 </function> /
 * </parameter> 收尾），導致 jinja 沒當 tool_call 攔下，整段漏進 content。
 *
 * 例：
 *   <function=Read>
 *   <parameter=file_path>
 *   C:\path\file.md
 *
 * 修法：adapter 在收尾時偵測 bare `<function=` 並合成 tool_use blocks。
 * 與 Hermes XML 兜底互斥（含 <tool_call> 走 XML 路徑、不重複合成）。
 */
import { describe, expect, test } from 'bun:test'
import {
  parseLeakedBarePythonicToolCalls,
  translateOpenAIStreamToAnthropic,
} from '../../../src/services/api/llamacpp-fetch-adapter'

function makeMockSseStream(
  events: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
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

describe('parseLeakedBarePythonicToolCalls', () => {
  test('無收尾標籤：<function=Read><parameter=file_path>...', () => {
    const text =
      '我來讀檔。\n<function=Read>\n<parameter=file_path>\nC:\\foo\\bar.md'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toEqual({
      name: 'Read',
      input: { file_path: 'C:\\foo\\bar.md' },
    })
    expect(r.strippedText).toBe('我來讀檔。')
  })

  test('含完整收尾：</parameter></function>', () => {
    const text =
      '<function=Bash><parameter=command>ls -la</parameter><parameter=description>列出</parameter></function>'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toEqual({
      name: 'Bash',
      input: { command: 'ls -la', description: '列出' },
    })
  })

  test('parameter value 跨行', () => {
    const text =
      '<function=Bash>\n<parameter=command>\necho line1\necho line2\n'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls[0]?.input.command).toBe('echo line1\necho line2')
  })

  test('多個 function 並列', () => {
    const text =
      '<function=Read>\n<parameter=file_path>/a\n<function=Bash>\n<parameter=command>ls'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls[0]?.name).toBe('Read')
    expect(r.toolCalls[0]?.input.file_path).toBe('/a')
    expect(r.toolCalls[1]?.name).toBe('Bash')
    expect(r.toolCalls[1]?.input.command).toBe('ls')
  })

  test('混合：含 </parameter> 半補', () => {
    const text =
      '<function=Read>\n<parameter=file_path>/a</parameter>\n<parameter=offset>10</parameter>'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls[0]?.input).toEqual({ file_path: '/a', offset: '10' })
  })

  test('無 <function= 標籤 → 原文回傳', () => {
    const text = 'just plain text'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.strippedText).toBe(text)
  })

  test('有 <function= 但無 <parameter= → 視為失敗', () => {
    const text = 'prefix <function=Read>\nsome unrelated text'
    const r = parseLeakedBarePythonicToolCalls(text)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.strippedText).toBe(text)
  })
})

describe('translateOpenAIStreamToAnthropic — bare pythonic leak fallback', () => {
  test('content 含 bare <function=Read>... 且無結構化 tool_calls → 合成 tool_use + stop_reason=tool_use', async () => {
    const leakText =
      '我來幫您讀檔。\n<function=Read>\n<parameter=file_path>\nC:\\foo.md'
    const events = [
      { id: 'cmpl-bp1', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'cmpl-bp1', choices: [{ index: 0, delta: { content: leakText } }] },
      {
        id: 'cmpl-bp1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-bp1')
    const { raw } = await collect(gen)

    expect(raw).toContain('"type":"tool_use"')
    expect(raw).toContain('"name":"Read"')
    expect(raw).toContain('input_json_delta')
    expect(raw).toContain('C:\\\\foo.md')
    expect(raw).toContain('toolu_pyfallback_')
    expect(raw).toMatch(/"stop_reason":\s*"tool_use"/)
  })

  test('bare 漏在 reasoning_content（thinking）→ 也應該被攔到', async () => {
    const leakInThinking =
      'Let me think.\n<function=Bash>\n<parameter=command>\npwd'
    const events = [
      { id: 'cmpl-bp2', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      {
        id: 'cmpl-bp2',
        choices: [{ index: 0, delta: { reasoning_content: leakInThinking } }],
      },
      {
        id: 'cmpl-bp2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-bp2')
    const { raw } = await collect(gen)
    expect(raw).toContain('"name":"Bash"')
    expect(raw).toContain('pwd')
    expect(raw).toMatch(/"stop_reason":\s*"tool_use"/)
  })

  test('同時含 <tool_call> 與 <function= → 走 Hermes XML 路徑（不重複合成）', async () => {
    const mixed =
      '<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>'
    const events = [
      { id: 'cmpl-bp3', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'cmpl-bp3', choices: [{ index: 0, delta: { content: mixed } }] },
      {
        id: 'cmpl-bp3',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-bp3')
    const { raw } = await collect(gen)
    expect(raw).toContain('"name":"Read"')
    // 走 Hermes 路徑而非 pyfallback
    expect(raw).toContain('toolu_xmlfallback_')
    expect(raw).not.toContain('toolu_pyfallback_')
    // 只應該合成一次（兩個 fallback 不可同時觸發）
    const matches = raw.match(/"name":"Read"/g)
    expect(matches?.length ?? 0).toBe(1)
  })

  test('純文字無任何標籤 → 不觸發 fallback', async () => {
    const events = [
      { id: 'cmpl-bp4', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'cmpl-bp4', choices: [{ index: 0, delta: { content: 'hello' } }] },
      {
        id: 'cmpl-bp4',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-bp4')
    const { raw } = await collect(gen)
    expect(raw).not.toContain('"type":"tool_use"')
    expect(raw).toMatch(/"stop_reason":\s*"end_turn"/)
  })
})
