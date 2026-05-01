/**
 * 階段 5 — VisionClient factory + llamacpp + disabled provider。
 *
 * 涵蓋：
 *   - resolveVisionProvider 選擇邏輯（env 顯式 / auto / 三 fallback 層）
 *   - LlamaCppVisionClient describe/locate → /chat/completions image_url payload
 *   - DisabledVisionClient 明確 throw 訊息、不硬吃 API key
 *   - isConfigured() 各 provider 的回應
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// LESSONS.md「mock.module 必須 spread」
const _realProviders_vf = await import('../../../src/utils/model/providers')
mock.module('../../../src/utils/model/providers', () => ({
  ..._realProviders_vf,
  isLlamaCppActive: () => true,
  getAPIProvider: () => 'llamacpp',
  isLlamaCppModel: () => true,
  getLlamaCppContextSize: () => null,
  isFirstPartyAnthropicBaseUrl: () => false,
  getAPIProviderForStatsig: () => 'llamacpp',
}))

// M-LLAMACPP-REMOTE: spread real index 與 spread real snapshot
const _realLlamacppConfig_vf = await import('../../../src/llamacppConfig/index')
const _realSnap_vf = _realLlamacppConfig_vf.getLlamaCppConfigSnapshot()
mock.module('../../../src/llamacppConfig/index', () => ({
  ..._realLlamacppConfig_vf,
  getLlamaCppConfigSnapshot: () => ({
    ..._realSnap_vf,
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'Gemopus-4-E4B-it-Preview',
  }),
  isVisionEnabled: () => true,
  resolveEndpoint: () => ({
    target: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'Gemopus-4-E4B-it-Preview',
    contextSize: 131072,
  }),
}))

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

beforeEach(() => {
  // 清乾淨環境 — 讓每個 test 自己設
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.VISION_PROVIDER
  delete process.env.MY_AGENT_VISION_MODEL
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

describe('resolveVisionProvider', () => {
  test('VISION_PROVIDER=anthropic 顯式', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider('anthropic', false, false)).toBe('anthropic')
  })

  test('VISION_PROVIDER=llamacpp 顯式', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider('llamacpp', false, false)).toBe('llamacpp')
  })

  test('VISION_PROVIDER=disabled 顯式', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider('disabled', true, true)).toBe('disabled')
  })

  test('auto + ANTHROPIC_API_KEY → anthropic', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider(undefined, true, false)).toBe('anthropic')
    expect(resolveVisionProvider('auto', true, false)).toBe('anthropic')
  })

  test('auto + 無 key + llamacpp active → llamacpp', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider(undefined, false, true)).toBe('llamacpp')
  })

  test('auto + 無 key + 無 llamacpp → disabled', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider(undefined, false, false)).toBe('disabled')
  })

  test('auto + key + llamacpp 同時 → 偏好 anthropic', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider(undefined, true, true)).toBe('anthropic')
  })

  test('奇怪的值 fallback 到 auto 邏輯', async () => {
    const { resolveVisionProvider } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    expect(resolveVisionProvider('banana', false, true)).toBe('llamacpp')
  })
})

describe('getDefaultVisionClient factory', () => {
  test('VISION_PROVIDER=disabled → DisabledVisionClient', async () => {
    process.env.VISION_PROVIDER = 'disabled'
    const mod = await import('../../../src/utils/vision/VisionClient')
    mod.resetVisionClientCache()
    const c = mod.getDefaultVisionClient()
    expect(c.backendName).toBe('disabled')
    expect(c.isConfigured()).toBe(false)
  })

  test('VISION_PROVIDER=llamacpp → LlamaCppVisionClient', async () => {
    process.env.VISION_PROVIDER = 'llamacpp'
    const mod = await import('../../../src/utils/vision/VisionClient')
    mod.resetVisionClientCache()
    const c = mod.getDefaultVisionClient()
    expect(c.backendName).toBe('llamacpp')
    expect(c.isConfigured()).toBe(true)
  })

  test('VISION_PROVIDER=anthropic + key → AnthropicVisionClient', async () => {
    process.env.VISION_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const mod = await import('../../../src/utils/vision/VisionClient')
    mod.resetVisionClientCache()
    const c = mod.getDefaultVisionClient()
    expect(c.backendName).toBe('anthropic')
    expect(c.isConfigured()).toBe(true)
  })
})

describe('DisabledVisionClient', () => {
  test('describe throws 可讀訊息', async () => {
    const { DisabledVisionClient } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    const c = new DisabledVisionClient()
    await expect(c.describe()).rejects.toThrow(/Vision is disabled/)
  })

  test('locate throws 可讀訊息', async () => {
    const { DisabledVisionClient } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    const c = new DisabledVisionClient()
    await expect(c.locate()).rejects.toThrow(/Vision is disabled/)
  })
})

describe('LlamaCppVisionClient', () => {
  test('describe → POST /chat/completions with image_url base64', async () => {
    let capturedBody: Record<string, unknown> = {}
    let capturedUrl = ''
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'A screenshot showing a login form.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    const { LlamaCppVisionClient } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    const c = new LlamaCppVisionClient()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header bytes
    const result = await c.describe(bytes, 'describe this')

    expect(result).toBe('A screenshot showing a login form.')
    expect(capturedUrl).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(capturedBody.model).toBe('Gemopus-4-E4B-it-Preview')
    const msgs = capturedBody.messages as Array<{
      content: Array<Record<string, unknown>>
    }>
    const blocks = msgs[0]!.content
    expect(blocks[0]!.type).toBe('text')
    expect((blocks[0]!.text as string)).toContain('describe this')
    expect(blocks[1]!.type).toBe('image_url')
    const imgUrl = (blocks[1]!.image_url as { url: string }).url
    expect(imgUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('locate 解析 JSON 並回 targets', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  '```json\n{"description":"login form","targets":[{"label":"submit","x":400,"y":300,"confidence":0.9}]}\n```',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch

    const { LlamaCppVisionClient } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    const c = new LlamaCppVisionClient()
    const res = await c.locate(new Uint8Array([0]), 'find submit', {
      viewportWidth: 800,
      viewportHeight: 600,
    })
    expect(res.description).toBe('login form')
    expect(res.targets.length).toBe(1)
    expect(res.targets[0]!.label).toBe('submit')
    expect(res.targets[0]!.x).toBe(400)
    expect(res.targets[0]!.y).toBe(300)
  })

  test('HTTP 500 → throw', async () => {
    globalThis.fetch = (async () =>
      new Response('oops', { status: 500 })) as typeof fetch
    const { LlamaCppVisionClient } = await import(
      '../../../src/utils/vision/VisionClient'
    )
    const c = new LlamaCppVisionClient()
    await expect(c.describe(new Uint8Array([0]), 'q')).rejects.toThrow(
      /HTTP 500/,
    )
  })
})
