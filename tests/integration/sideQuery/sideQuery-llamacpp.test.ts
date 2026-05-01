/**
 * 階段 1 — sideQuery 在 llamacpp 模式下直通本地端點的單元測試。
 *
 * 透過 mock.module 換掉 providers / llamacppConfig，並 patch global.fetch，
 * 不打真 LLM、不需要真 server、不依賴 ANTHROPIC_API_KEY。
 *
 * 涵蓋：
 *   - request body 映射：system / messages / max_tokens / temperature / stop / tools / tool_choice
 *   - response 包裝回 BetaMessage-shape：text / tool_use / thinking / usage / stop_reason
 *   - error path：HTTP 500 → throw
 *   - output_format 降級：不報錯（warn log），繼續送 request
 *   - user assistant tool_use 來回 trip：Anthropic tool_use block → OpenAI tool_calls
 *   - user tool_result → OpenAI 'tool' role message
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// LESSONS.md「mock.module 必須 spread」：spread real，僅 override 必要 stubs。
// 不 spread 會讓其他 test import providers 的 named exports（getLlamaCppConfig
// 等）拿到 undefined → SyntaxError。
const _realProviders_sq = await import('../../../src/utils/model/providers')
mock.module('../../../src/utils/model/providers', () => ({
  ..._realProviders_sq,
  isLlamaCppActive: () => true,
  getAPIProvider: () => 'llamacpp',
  isLlamaCppModel: () => true,
  getLlamaCppContextSize: () => null,
}))

// M-LLAMACPP-REMOTE: spread real index 與 spread real snapshot
const _realLlamacppConfig_sq = await import('../../../src/llamacppConfig/index')
const _realSnap_sq = _realLlamacppConfig_sq.getLlamaCppConfigSnapshot()
mock.module('../../../src/llamacppConfig/index', () => ({
  ..._realLlamacppConfig_sq,
  getLlamaCppConfigSnapshot: () => ({
    ..._realSnap_sq,
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test-model',
  }),
  isVisionEnabled: () => false,
  resolveEndpoint: () => ({
    target: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test-model',
    contextSize: 131072,
  }),
}))

type FetchCall = {
  url: string
  init: RequestInit | undefined
  body: Record<string, unknown>
}

const calls: FetchCall[] = []
const originalFetch = globalThis.fetch

function setFetchResponse(json: unknown, status = 200): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      body = {}
    }
    calls.push({ url: String(url), init, body })
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Request body 映射
// ---------------------------------------------------------------------------

describe('sideQueryViaLlamaCpp — request mapping', () => {
  test('basic text query 映射到 OpenAI chat/completions', async () => {
    setFetchResponse({
      id: 'cmpl_1',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'hi back' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      temperature: 0.2,
      querySource: 'session_search',
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('test-model')
    expect(calls[0]!.body.max_tokens).toBe(128)
    expect(calls[0]!.body.temperature).toBe(0.2)
    const msgs = calls[0]!.body.messages as Array<{
      role: string
      content: string
    }>
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' })

    expect(res.content[0]).toEqual({
      type: 'text',
      text: 'hi back',
      citations: null,
    })
    expect(res.stop_reason).toBe('end_turn')
    expect(res.usage.input_tokens).toBe(10)
    expect(res.usage.output_tokens).toBe(3)
  })

  test('system 為 TextBlockParam[] 時 flatten 成字串', async () => {
    setFetchResponse({
      id: 'cmpl_2',
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    await sideQueryViaLlamaCpp({
      model: 'test-model',
      system: [
        { type: 'text', text: 'block A' },
        { type: 'text', text: 'block B' },
      ],
      messages: [{ role: 'user', content: 'q' }],
      querySource: 'session_search',
    })
    const msgs = calls[0]!.body.messages as Array<{ role: string; content: string }>
    expect(msgs[0]).toEqual({ role: 'system', content: 'block A\n\nblock B' })
  })

  test('stop_sequences 映射到 OpenAI stop', async () => {
    setFetchResponse({
      id: 'cmpl_3',
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'x' } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      stop_sequences: ['</block>', '```'],
      querySource: 'auto_mode',
    })
    expect(calls[0]!.body.stop).toEqual(['</block>', '```'])
  })

  test('tools + tool_choice: "tool" 映射到 OpenAI function', async () => {
    setFetchResponse({
      id: 'cmpl_4',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'explain', arguments: '{"risk":"low"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'explain this' }],
      tools: [
        {
          name: 'explain',
          description: 'Explain a command',
          input_schema: {
            type: 'object',
            properties: { risk: { type: 'string' } },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'explain' },
      querySource: 'permission_explainer',
    })

    const tools = calls[0]!.body.tools as Array<{
      type: string
      function: { name: string }
    }>
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('explain')
    expect(calls[0]!.body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'explain' },
    })

    expect(res.stop_reason).toBe('tool_use')
    const toolUse = res.content.find(c => c.type === 'tool_use')
    expect(toolUse).toBeDefined()
    if (toolUse && toolUse.type === 'tool_use') {
      expect(toolUse.name).toBe('explain')
      expect(toolUse.id).toBe('call_1')
      expect(toolUse.input).toEqual({ risk: 'low' })
    }
  })

  test('assistant tool_use → OpenAI tool_calls；user tool_result → OpenAI tool role', async () => {
    setFetchResponse({
      id: 'cmpl_5',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [
        { role: 'user', content: 'run bash' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'will do' },
            {
              type: 'tool_use',
              id: 'call_42',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_42',
              content: 'file.txt',
            },
          ],
        },
      ],
      querySource: 'auto_mode',
    })
    const msgs = calls[0]!.body.messages as Array<{
      role: string
      content?: string | null
      tool_calls?: Array<{ id: string; function: { name: string } }>
      tool_call_id?: string
    }>
    // system(0 if absent) skipped; first is user
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.role).toBe('assistant')
    expect(msgs[1]!.content).toBe('will do')
    expect(msgs[1]!.tool_calls?.[0]!.id).toBe('call_42')
    expect(msgs[2]!.role).toBe('tool')
    expect(msgs[2]!.tool_call_id).toBe('call_42')
    expect(msgs[2]!.content).toBe('file.txt')
  })
})

// ---------------------------------------------------------------------------
// Response 包裝
// ---------------------------------------------------------------------------

describe('sideQueryViaLlamaCpp — response shape', () => {
  test('reasoning_content → thinking block', async () => {
    setFetchResponse({
      id: 'cmpl_6',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_content: 'let me think...',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 5 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      querySource: 'auto_mode',
    })
    expect(res.content[0]!.type).toBe('thinking')
    expect(res.content[1]!.type).toBe('text')
    if (res.content[0]!.type === 'thinking') {
      expect(res.content[0]!.thinking).toBe('let me think...')
    }
  })

  test('finish_reason=length → stop_reason=max_tokens', async () => {
    setFetchResponse({
      id: 'cmpl_7',
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: 'truncated...' },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 100 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      querySource: 'session_search',
    })
    expect(res.stop_reason).toBe('max_tokens')
  })

  test('cached_tokens → cache_read_input_tokens', async () => {
    setFetchResponse({
      id: 'cmpl_8',
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'x' } },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      querySource: 'session_search',
    })
    expect(res.usage.cache_read_input_tokens).toBe(80)
    expect(res.usage.input_tokens).toBe(100)
  })

  test('empty content → placeholder text block (避免 caller 找不到 text)', async () => {
    setFetchResponse({
      id: 'cmpl_9',
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: null } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      querySource: 'session_search',
    })
    expect(res.content.length).toBe(1)
    expect(res.content[0]!.type).toBe('text')
  })
})

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('sideQueryViaLlamaCpp — error path', () => {
  test('HTTP 500 → throw Error', async () => {
    setFetchResponse({ error: 'server exploded' }, 500)
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    await expect(
      sideQueryViaLlamaCpp({
        model: 'test-model',
        messages: [{ role: 'user', content: 'q' }],
        querySource: 'session_search',
      }),
    ).rejects.toThrow(/llama\.cpp sideQuery HTTP 500/)
  })

  test('缺少 choices[0] → throw Error', async () => {
    setFetchResponse({ id: 'bad', choices: [] })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    await expect(
      sideQueryViaLlamaCpp({
        model: 'test-model',
        messages: [{ role: 'user', content: 'q' }],
        querySource: 'session_search',
      }),
    ).rejects.toThrow(/回應缺少 choices/)
  })

  test('output_format 不報錯（降級為純 prompt），request 仍送出', async () => {
    setFetchResponse({
      id: 'cmpl_10',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"x":1}' },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 5 },
    })
    const { sideQueryViaLlamaCpp } = await import(
      '../../../src/services/api/llamacppSideQuery'
    )
    const res = await sideQueryViaLlamaCpp({
      model: 'test-model',
      messages: [{ role: 'user', content: 'q' }],
      output_format: {
        type: 'json_schema',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      querySource: 'memdir_relevance',
    })
    expect(calls.length).toBe(1)
    // OpenAI body 不含 response_format（我們未翻譯）
    expect('response_format' in calls[0]!.body).toBe(false)
    // caller 仍拿到 text 自己 parse
    expect(res.content[0]!.type).toBe('text')
  })
})
