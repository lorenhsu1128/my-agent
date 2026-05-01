/**
 * 階段 3 — tokenEstimation 在 llamacpp 模式下改走 /tokenize 端點。
 *
 * 驗證：
 *   - countMessagesTokensWithAPI 走 /tokenize 回正確 token count
 *   - countTokensViaHaikuFallback 同上
 *   - /tokenize baseUrl 去掉 /v1 尾段（llama.cpp 原生 endpoint 非 /v1 prefix）
 *   - HTTP 失敗 / endpoint 不存在 / network error → null（caller 降級）
 *   - messages + tools 被 serialize 成單一 text blob
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// LESSONS.md「mock.module 必須 spread」：spread real，僅 override 必要 stubs
const _realProviders_te = await import('../../../src/utils/model/providers')
mock.module('../../../src/utils/model/providers', () => ({
  ..._realProviders_te,
  isLlamaCppActive: () => true,
  getAPIProvider: () => 'llamacpp',
  isLlamaCppModel: () => true,
  getLlamaCppContextSize: () => null,
  isFirstPartyAnthropicBaseUrl: () => false,
  getAPIProviderForStatsig: () => 'llamacpp',
}))

// M-LLAMACPP-REMOTE: spread real index 與 spread real snapshot
const realLlamacppConfig = await import('../../../src/llamacppConfig/index')
const _realSnap_te = realLlamacppConfig.getLlamaCppConfigSnapshot()
mock.module('../../../src/llamacppConfig/index', () => ({
  ...realLlamacppConfig,
  getLlamaCppConfigSnapshot: () => ({
    ..._realSnap_te,
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

// withTokenCountVCR 在 NODE_ENV=test 下會從 fixtures/token-count-*.json 讀
// cache，前次 test run 寫下的固定值會阻擋 fetch mock 被呼叫。本測試不依賴
// fixture 比對、每次都要真的走 /tokenize fetch 路徑，所以 bypass VCR。
mock.module('../../../src/services/vcr', () => ({
  withTokenCountVCR: async (
    _messages: unknown,
    _tools: unknown,
    f: () => Promise<number | null>,
  ) => f(),
  withVCR: async (_msgs: unknown, f: () => Promise<unknown>) => f(),
  withStreamingVCR: async function* (
    _msgs: unknown,
    f: () => AsyncGenerator<unknown>,
  ) {
    yield* f()
  },
}))

type FetchCall = {
  url: string
  body: Record<string, unknown>
}

const calls: FetchCall[] = []
const originalFetch = globalThis.fetch

function setTokenizeResponse(tokens: number[] | null, status = 200): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      body = {}
    }
    calls.push({ url: String(url), body })
    if (tokens === null) {
      return new Response('err', { status })
    }
    return new Response(JSON.stringify({ tokens }), {
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

describe('countMessagesTokensWithAPI — llamacpp path', () => {
  test('成功路徑：回 tokens.length', async () => {
    setTokenizeResponse(new Array(42).fill(0))
    const { countMessagesTokensWithAPI } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'hello world' }],
      [],
    )
    expect(count).toBe(42)
    expect(calls.length).toBe(1)
    // /tokenize 是 llama.cpp 原生端點，不在 /v1 prefix 下
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/tokenize')
    expect(typeof calls[0]!.body.content).toBe('string')
    expect(calls[0]!.body.content).toContain('user:')
    expect(calls[0]!.body.content).toContain('hello world')
  })

  test('tools + messages 都 serialize 進 content', async () => {
    setTokenizeResponse(new Array(99).fill(0))
    const { countMessagesTokensWithAPI } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countMessagesTokensWithAPI(
      [
        { role: 'user', content: 'run bash' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'will do' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      ],
      [
        {
          name: 'Bash',
          description: 'run shell',
          input_schema: { type: 'object', properties: {} },
        },
      ] as never,
    )
    expect(count).toBe(99)
    const content = calls[0]!.body.content as string
    expect(content).toContain('Bash')
    expect(content).toContain('run bash')
    expect(content).toContain('will do')
    expect(content).toContain('[tool_use Bash]')
  })

  test('HTTP 500 → null（caller 降級）', async () => {
    setTokenizeResponse(null, 500)
    const { countMessagesTokensWithAPI } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'q' }],
      [],
    )
    expect(count).toBeNull()
  })

  test('response 缺 tokens 欄位 → null', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    const { countMessagesTokensWithAPI } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'q' }],
      [],
    )
    expect(count).toBeNull()
  })

  test('網路錯誤 → null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const { countMessagesTokensWithAPI } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'q' }],
      [],
    )
    expect(count).toBeNull()
  })
})

describe('countTokensViaHaikuFallback — llamacpp path', () => {
  test('成功路徑：回 tokens.length', async () => {
    setTokenizeResponse(new Array(77).fill(0))
    const { countTokensViaHaikuFallback } = await import(
      '../../../src/services/tokenEstimation'
    )
    const count = await countTokensViaHaikuFallback(
      [{ role: 'user', content: 'fallback test' }],
      [],
    )
    expect(count).toBe(77)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/tokenize')
  })

  test('tool_result 進 content', async () => {
    setTokenizeResponse(new Array(3).fill(0))
    const { countTokensViaHaikuFallback } = await import(
      '../../../src/services/tokenEstimation'
    )
    await countTokensViaHaikuFallback(
      [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              content: 'file content here',
            },
          ],
        },
      ],
      [],
    )
    expect(calls[0]!.body.content).toContain('[tool_result]')
    expect(calls[0]!.body.content).toContain('file content here')
  })
})
