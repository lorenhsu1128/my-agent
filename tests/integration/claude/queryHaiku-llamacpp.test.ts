/**
 * 階段 2 — queryHaiku 在 llamacpp 模式下直通 sideQueryViaLlamaCpp。
 *
 * 驗證 queryHaiku 在 isLlamaCppActive() 時：
 *   - 打到 /chat/completions 端點（而非走 Anthropic SDK）
 *   - 回傳 AssistantMessage shape（type='assistant', message.content 非空）
 *   - userPrompt / systemPrompt 正確映射到 OpenAI messages
 *   - outputFormat 不報錯（降級為純 prompt）
 *
 * 設計：完全不用 mock.module（bun:test 的 mock.module 是 process-global
 * 且不能 unmock，會跨檔污染整個 process）。改用：
 *   1. MY_AGENT_USE_LLAMACPP=1 env 觸發 isLlamaCppActive() 自然回 true
 *   2. mock globalThis.fetch 攔截 /chat/completions 請求
 *   3. expect 動態使用 real resolveEndpoint('sideQuery') 的 baseUrl/model
 *      （而不是硬編 127.0.0.1:8080），因 real config 來自使用者環境
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

const _origUseLlamacpp = process.env.MY_AGENT_USE_LLAMACPP
process.env.MY_AGENT_USE_LLAMACPP = '1'

// 動態取得 real endpoint，避免硬編。test 對 url/model 的 expect 都依此。
const { resolveEndpoint } = await import(
  '../../../src/llamacppConfig/index'
)
const _ep = resolveEndpoint('sideQuery')
const EXPECTED_BASE_URL = _ep.baseUrl
const EXPECTED_MODEL = _ep.model

type FetchCall = {
  url: string
  body: Record<string, unknown>
}

const calls: FetchCall[] = []
const originalFetch = globalThis.fetch

function setFetchResponse(json: unknown, status = 200): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      body = {}
    }
    calls.push({ url: String(url), body })
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

afterAll(() => {
  if (_origUseLlamacpp === undefined) delete process.env.MY_AGENT_USE_LLAMACPP
  else process.env.MY_AGENT_USE_LLAMACPP = _origUseLlamacpp
})

describe('queryHaiku — llamacpp path', () => {
  test('回傳 AssistantMessage shape，content 含 text', async () => {
    setFetchResponse({
      id: 'cmpl_haiku_1',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"cron":"0 9 * * *"}' },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    })

    const { queryHaiku } = await import('../../../src/services/api/claude')
    const { asSystemPrompt } = await import(
      '../../../src/utils/systemPromptType'
    )

    const result = await queryHaiku({
      systemPrompt: asSystemPrompt(['You parse cron.']),
      userPrompt: 'every morning at 9am',
      signal: AbortSignal.timeout(5000),
      options: {
        querySource: 'cron_nl_parser' as never,
        enablePromptCaching: false,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // AssistantMessage shape
    expect(result.type).toBe('assistant')
    expect(result.message.role).toBe('assistant')
    expect(Array.isArray(result.message.content)).toBe(true)

    const textBlock = result.message.content.find(b => b.type === 'text')
    expect(textBlock).toBeDefined()
    if (textBlock && textBlock.type === 'text') {
      expect(textBlock.text).toBe('{"cron":"0 9 * * *"}')
    }

    // fetch 被呼叫到正確端點（baseUrl 來自使用者 real config）
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe(`${EXPECTED_BASE_URL}/chat/completions`)
    expect(calls[0]!.body.model).toBe(EXPECTED_MODEL)

    // system + user 被映射
    const msgs = calls[0]!.body.messages as Array<{
      role: string
      content: string
    }>
    expect(msgs[0]).toEqual({ role: 'system', content: 'You parse cron.' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'every morning at 9am' })
  })

  test('outputFormat 降級為純 prompt（不報錯）', async () => {
    setFetchResponse({
      id: 'cmpl_haiku_2',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"ok":1}' },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 4 },
    })

    const { queryHaiku } = await import('../../../src/services/api/claude')
    const { asSystemPrompt } = await import(
      '../../../src/utils/systemPromptType'
    )

    const result = await queryHaiku({
      systemPrompt: asSystemPrompt(['json please']),
      userPrompt: 'q',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      signal: AbortSignal.timeout(5000),
      options: {
        querySource: 'tool_use_summary' as never,
        enablePromptCaching: false,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    expect(result.type).toBe('assistant')
    // request body 不含 response_format（我們未翻譯）
    expect('response_format' in calls[0]!.body).toBe(false)
  })

  test('HTTP 500 → throw', async () => {
    setFetchResponse({ error: 'oops' }, 500)
    const { queryHaiku } = await import('../../../src/services/api/claude')
    const { asSystemPrompt } = await import(
      '../../../src/utils/systemPromptType'
    )
    await expect(
      queryHaiku({
        systemPrompt: asSystemPrompt([]),
        userPrompt: 'q',
        signal: AbortSignal.timeout(5000),
        options: {
          querySource: 'tool_use_summary' as never,
          enablePromptCaching: false,
          agents: [],
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          mcpTools: [],
        },
      }),
    ).rejects.toThrow(/HTTP 500/)
  })
})
