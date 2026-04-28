/**
 * M-MEMRECALL-LOCAL: 純函式單元 + selector → fetch 整合測試。
 *
 * 涵蓋：
 *   1. extractFilenamesFromText：各種 LLM 輸出格式（純 array / fenced / wrapped object / 文字混雜）
 *   2. extractFilenamesFromText：invalid filename 過濾
 *   3. extractFilenamesFromText：空 / null / 解析失敗 → []
 *
 * selectViaLlamaCpp 的 fetch path 用 mock 驗證 HTTP / abort / parse error 三類失敗。
 *
 * 不打真 LLM；不依賴 ANTHROPIC_API_KEY；不需要真 llama.cpp server。
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { extractFilenamesFromText } from '../../../src/memdir/findRelevantMemories'

describe('extractFilenamesFromText — clean JSON array', () => {
  const valid = new Set(['weather.md', 'auth.md', 'docker.md'])

  test('plain array', () => {
    expect(extractFilenamesFromText('["weather.md","auth.md"]', valid)).toEqual([
      'weather.md',
      'auth.md',
    ])
  })

  test('array with whitespace', () => {
    expect(
      extractFilenamesFromText('  [ "weather.md" , "auth.md" ]  ', valid),
    ).toEqual(['weather.md', 'auth.md'])
  })

  test('empty array', () => {
    expect(extractFilenamesFromText('[]', valid)).toEqual([])
  })

  test('multi-line array', () => {
    expect(
      extractFilenamesFromText(
        '[\n  "weather.md",\n  "auth.md"\n]',
        valid,
      ),
    ).toEqual(['weather.md', 'auth.md'])
  })
})

describe('extractFilenamesFromText — wrapped/dirty output', () => {
  const valid = new Set(['weather.md', 'auth.md'])

  test('markdown fence ```json ... ```', () => {
    expect(
      extractFilenamesFromText(
        '```json\n["weather.md"]\n```',
        valid,
      ),
    ).toEqual(['weather.md'])
  })

  test('plain markdown fence ``` ... ```', () => {
    expect(
      extractFilenamesFromText('```\n["weather.md"]\n```', valid),
    ).toEqual(['weather.md'])
  })

  test('preamble text + array', () => {
    expect(
      extractFilenamesFromText(
        'Here are the relevant files:\n["weather.md", "auth.md"]',
        valid,
      ),
    ).toEqual(['weather.md', 'auth.md'])
  })

  test('object form { selected_memories: [...] }', () => {
    expect(
      extractFilenamesFromText(
        '{"selected_memories": ["weather.md"]}',
        valid,
      ),
    ).toEqual(['weather.md'])
  })

  test('object form takes first array if both patterns match — array wins', () => {
    // Array regex matches first; we accept that.
    expect(
      extractFilenamesFromText(
        '{"selected_memories":["weather.md","auth.md"]}',
        valid,
      ),
    ).toEqual(['weather.md', 'auth.md'])
  })
})

describe('extractFilenamesFromText — filtering invalid', () => {
  const valid = new Set(['weather.md'])

  test('filters out filenames not in validFilenames', () => {
    expect(
      extractFilenamesFromText(
        '["weather.md","ghost.md","auth.md"]',
        valid,
      ),
    ).toEqual(['weather.md'])
  })

  test('all invalid → empty', () => {
    expect(extractFilenamesFromText('["ghost.md","fake.md"]', valid)).toEqual(
      [],
    )
  })

  test('non-string entries dropped (whole array rejected by type guard)', () => {
    // Array contains a number; type guard fails → fall through to object form
    // → object form also fails → []. This is the conservative behaviour.
    expect(extractFilenamesFromText('["weather.md", 42]', valid)).toEqual([])
  })
})

describe('extractFilenamesFromText — failure modes', () => {
  const valid = new Set(['weather.md'])

  test('empty string → []', () => {
    expect(extractFilenamesFromText('', valid)).toEqual([])
  })

  test('plain prose, no JSON → []', () => {
    expect(
      extractFilenamesFromText(
        'I think you should look at weather.md',
        valid,
      ),
    ).toEqual([])
  })

  test('malformed JSON in array → []', () => {
    expect(
      extractFilenamesFromText('["weather.md', valid),
    ).toEqual([])
  })

  test('not JSON at all → []', () => {
    expect(extractFilenamesFromText('null', valid)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// selectViaLlamaCpp via mocked fetch
// ---------------------------------------------------------------------------
//
// The function is module-private so we exercise it through the public path:
// findRelevantMemories → selectRelevantMemories (llamacpp branch) → fetch.
// ESM exports are readonly so we use bun:test's mock.module to swap providers
// + llamacppConfig + memoryScan, and patch global.fetch directly.

import type { MemoryHeader } from '../../../src/memdir/memoryScan'

type FetchInit = Parameters<typeof fetch>[1]

const FAKE_MEMORY_HEADERS: MemoryHeader[] = [
  {
    filename: 'weather.md',
    filePath: '/tmp/memory/weather.md',
    mtimeMs: Date.now(),
    description: '使用 wttr.in 查詢天氣',
    type: 'feedback',
  },
  {
    filename: 'auth.md',
    filePath: '/tmp/memory/auth.md',
    mtimeMs: Date.now() - 1000,
    description: 'OAuth 2.0 流程',
    type: 'reference',
  },
]

let scanResult: MemoryHeader[] = FAKE_MEMORY_HEADERS

mock.module('../../../src/utils/model/providers', () => ({
  isLlamaCppActive: () => true,
  getAPIProvider: () => 'llamacpp',
  isLlamaCppModel: () => true,
  getLlamaCppModelAliases: () => [],
  LLAMACPP_MODEL_ALIASES: [],
  DEFAULT_LLAMACPP_BASE_URL: 'http://localhost:8080/v1',
  DEFAULT_LLAMACPP_MODEL: 'qwen3.5-9b-neo',
}))

// M-LLAMACPP-REMOTE: spread real index（LESSONS.md「mock.module 必須 spread」）
const _realLlamacppConfig_fr = await import('../../../src/llamacppConfig')
mock.module('../../../src/llamacppConfig', () => ({
  ..._realLlamacppConfig_fr,
  getLlamaCppConfigSnapshot: () => ({
    baseUrl: 'http://localhost:8080/v1',
    model: 'qwen3.5-9b-neo',
  }),
  resolveEndpoint: () => ({
    target: 'local',
    baseUrl: 'http://localhost:8080/v1',
    model: 'qwen3.5-9b-neo',
    contextSize: 131072,
  }),
}))

mock.module('../../../src/memdir/memoryScan', () => ({
  scanMemoryFiles: async () => scanResult,
  formatMemoryManifest: (memories: MemoryHeader[]): string =>
    memories.map(m => `- ${m.filename}: ${m.description ?? ''}`).join('\n'),
}))

// Imported AFTER mock.module so the mocked modules are bound at import time.
const findModule = await import('../../../src/memdir/findRelevantMemories')

describe('findRelevantMemories — llamacpp branch + fallback', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = global.fetch
    scanResult = FAKE_MEMORY_HEADERS
  })
  afterEach(() => {
    global.fetch = originalFetch
  })
  test('selector returns valid array → exact match wins, no fallback', async () => {
    global.fetch = (async (
      _url: string | URL | Request,
      init: FetchInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      // Sanity: prompt contains query + manifest
      expect(body.messages[1].content).toContain('weather')
      expect(body.messages[1].content).toContain('weather.md')
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '["weather.md"]' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'how do I check the weather?',
      '/tmp/memory',
      ctrl.signal,
    )
    expect(result.map(r => r.path)).toEqual(['/tmp/memory/weather.md'])
  })

  test('selector HTTP 500 → fallback attaches freshest N', async () => {
    global.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'whatever',
      '/tmp/memory',
      ctrl.signal,
    )
    // Both fake memories returned (freshest first), capped at FALLBACK_MAX_FILES=8
    expect(result).toHaveLength(2)
    expect(result[0]!.path).toBe('/tmp/memory/weather.md')
  })

  test('selector returns empty array → fallback attaches freshest N', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
        { status: 200 },
      )) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'unrelated query',
      '/tmp/memory',
      ctrl.signal,
    )
    expect(result).toHaveLength(2)
  })

  test('selector returns parse-failing text → fallback attaches freshest N', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'I think weather.md helps' } }],
        }),
        { status: 200 },
      )) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'weather?',
      '/tmp/memory',
      ctrl.signal,
    )
    expect(result).toHaveLength(2)
  })

  test('network error → fallback attaches freshest N', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8080')
    }) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'weather?',
      '/tmp/memory',
      ctrl.signal,
    )
    expect(result).toHaveLength(2)
  })

  test('alreadySurfaced filter applied before selector', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '["weather.md","auth.md"]' } }],
        }),
        { status: 200 },
      )) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'weather?',
      '/tmp/memory',
      ctrl.signal,
      [],
      new Set(['/tmp/memory/auth.md']),
    )
    expect(result.map(r => r.path)).toEqual(['/tmp/memory/weather.md'])
  })

  test('zero memory files → returns [] (no fallback to fabricate)', async () => {
    scanResult = []

    global.fetch = (async () => {
      throw new Error('should not be called')
    }) as typeof fetch

    const ctrl = new AbortController()
    const result = await findModule.findRelevantMemories(
      'weather?',
      '/tmp/memory',
      ctrl.signal,
    )
    expect(result).toEqual([])
  })
})
