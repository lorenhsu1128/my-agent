/**
 * XML tool-call leak fallback：Qwen3.5 thinking 結束後**有時**會 fall back 到
 * native Hermes-style XML 格式直接寫進 content text，jinja parser 沒攔截。
 *
 * 例：
 *   <tool_call>
 *   <function=Bash>
 *   <parameter=command>ls -la</parameter>
 *   </function>
 *   </tool_call>
 *
 * 修法：adapter 在收尾時偵測 <tool_call> 並合成 tool_use blocks，把
 * stop_reason 改成 tool_use。違反 ADR-021 silent fallback — 但有 loud warn。
 *
 * 根治走 server 端 --chat-template-kwargs '{"enable_thinking":false}'。
 */
import { describe, expect, test } from 'bun:test'
import {
  parseLeakedXmlToolCalls,
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

describe('parseLeakedXmlToolCalls', () => {
  test('單個 tool_call 含 2 個 parameter', () => {
    const text =
      '正在分析。\n<tool_call>\n<function=Bash>\n<parameter=command>ls -la src/</parameter>\n<parameter=description>列出 src</parameter>\n</function>\n</tool_call>'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toEqual({
      name: 'Bash',
      input: { command: 'ls -la src/', description: '列出 src' },
    })
    expect(r.strippedText).toBe('正在分析。\n')
  })

  test('多個 tool_call 並列', () => {
    const text =
      '<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>middle<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>tail'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls[0]?.name).toBe('Read')
    expect(r.toolCalls[1]?.name).toBe('Bash')
    expect(r.strippedText).toBe('middletail')
  })

  test('parameter value 含換行（多行 command）', () => {
    const text =
      '<tool_call><function=Bash><parameter=command>echo line1\necho line2</parameter></function></tool_call>'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls[0]?.input.command).toBe('echo line1\necho line2')
  })

  test('無 tool_call 標籤 → 原文回傳', () => {
    const text = 'just plain text with no markers'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.strippedText).toBe(text)
  })

  test('不完整 tool_call（缺 closing tag）→ 視為無 tool', () => {
    const text = '<tool_call><function=Bash><parameter=command>ls'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.strippedText).toBe(text)
  })

  test('tool_call 內缺 function tag → skip 該 block', () => {
    const text = '<tool_call>broken inside</tool_call>後面'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(0)
    // 沒任何成功 parse 的 → 視為失敗，整段不剝
    expect(r.strippedText).toBe(text)
  })

  test('混合：一個成功 + 一個 broken → 只回成功的', () => {
    const text =
      '<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>x<tool_call>broken</tool_call>'
    const r = parseLeakedXmlToolCalls(text)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.name).toBe('Bash')
    // broken 那塊也會被 regex 剝掉（因為符合 <tool_call>...</tool_call>）
    expect(r.strippedText).toBe('x')
  })
})

describe('translateOpenAIStreamToAnthropic — XML leak fallback', () => {
  test('content 含 <tool_call> XML 且無結構化 tool_calls → 合成 tool_use block + stop_reason=tool_use', async () => {
    const xmlText =
      '我來幫您查詢。\n<tool_call>\n<function=Bash>\n<parameter=command>ls -la src/</parameter>\n</function>\n</tool_call>'
    const events = [
      { id: 'cmpl-1', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: { content: xmlText } }] },
      {
        id: 'cmpl-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-x')
    const { raw } = await collect(gen)

    // 應該看到合成的 tool_use content_block_start + input_json_delta
    expect(raw).toContain('"type":"tool_use"')
    expect(raw).toContain('"name":"Bash"')
    expect(raw).toContain('input_json_delta')
    expect(raw).toContain('ls -la src/')
    // stop_reason 必須改成 tool_use
    expect(raw).toMatch(/"stop_reason":\s*"tool_use"/)
  })

  test('content 為純文字（無 XML）→ 不觸發 fallback、stop_reason=end_turn', async () => {
    const events = [
      { id: 'cmpl-2', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'cmpl-2', choices: [{ index: 0, delta: { content: 'hello world' } }] },
      {
        id: 'cmpl-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-y')
    const { raw } = await collect(gen)
    expect(raw).not.toContain('"type":"tool_use"')
    expect(raw).toMatch(/"stop_reason":\s*"end_turn"/)
  })

  test('XML 漏在 reasoning_content（thinking）→ 也應該被 fallback 攔到', async () => {
    const xmlInThinking =
      'Let me think.\n<tool_call>\n<function=Bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>'
    const events = [
      { id: 'cmpl-r', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      {
        id: 'cmpl-r',
        choices: [{ index: 0, delta: { reasoning_content: xmlInThinking } }],
      },
      {
        id: 'cmpl-r',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-r')
    const { raw } = await collect(gen)
    expect(raw).toContain('"name":"Bash"')
    expect(raw).toContain('input_json_delta')
    expect(raw).toContain('pwd')
    expect(raw).toMatch(/"stop_reason":\s*"tool_use"/)
  })

  test('已有結構化 tool_calls + content 同時含 XML → 不重複合成（structured 優先）', async () => {
    const events = [
      { id: 'cmpl-3', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      {
        id: 'cmpl-3',
        choices: [
          {
            index: 0,
            delta: {
              content:
                '<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>',
            },
          },
        ],
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
                  id: 'call_real',
                  type: 'function',
                  function: { name: 'Bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'cmpl-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ]
    const stream = makeMockSseStream(events)
    const gen = translateOpenAIStreamToAnthropic(stream, 'qwen3.5-9b', 'msg-z')
    const { raw } = await collect(gen)
    // 真實的 Bash tool_call 應該有
    expect(raw).toContain('"name":"Bash"')
    // 不應合成 fallback 的 Read（因為已有結構化 tool_calls）
    expect(raw).not.toContain('"name":"Read"')
    expect(raw).not.toContain('toolu_xmlfallback_')
  })
})
