/**
 * 階段 2 — queryHaiku 在 llamacpp 模式下直通 sideQueryViaLlamaCpp。
 *
 * 驗證 queryHaiku 在 isLlamaCppActive() 時：
 *   - 打到 /chat/completions 端點（而非走 Anthropic SDK）
 *   - 回傳 AssistantMessage shape（type='assistant', message.content 非空）
 *   - userPrompt / systemPrompt 正確映射到 OpenAI messages
 *   - outputFormat 不報錯（降級為純 prompt）
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// 不 mock providers 模組（會跨檔污染整個 process — bun:test 不能 unmock）。
// 改用 env flag 讓 isLlamaCppActive() 自然回 true：MY_AGENT_USE_LLAMACPP=1
// 配合下方 llamacppConfig/index 的 snapshot mock 提供假 baseUrl/model。
const _origUseLlamacpp = process.env.MY_AGENT_USE_LLAMACPP
process.env.MY_AGENT_USE_LLAMACPP = '1'

// M-LLAMACPP-REMOTE: spread real index 與 spread real snapshot（LESSONS.md
// 「mock.module 必須 spread」）。snapshot 必須 spread real 預設，否則只給
// { baseUrl, model } 會讓後續 test 透過 context.ts 讀 cfg.contextSize/
// modelAliases 等欄位變 undefined → NaN 連鎖。
const _realLlamacppConfig_qh = await import('../../../src/llamacppConfig/index')
const _realSnap_qh = _realLlamacppConfig_qh.getLlamaCppConfigSnapshot()
mock.module('../../../src/llamacppConfig/index', () => ({
  ..._realLlamacppConfig_qh,
  getLlamaCppConfigSnapshot: () => ({
    ..._realSnap_qh,
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test-haiku-model',
  }),
  isVisionEnabled: () => false,
  resolveEndpoint: () => ({
    target: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test-haiku-model',
    contextSize: 131072,
  }),
}))

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

    // fetch 被呼叫到正確端點
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/v1/chat/completions')

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
