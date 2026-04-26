// M-LLAMACPP-WATCHDOG Phase 1-4：watchdog 純函式 + stream 包裝單元測試。
// 不依賴真 fetch / SSE — 用 in-memory async iterator 測完整邏輯。

import { describe, expect, test } from 'bun:test'
import {
  WatchdogAbortError,
  chunkIsContent,
  chunkIsReasoning,
  createWatchdogState,
  estimateChunkTokens,
  getTokenCap,
  layerActive,
  tickChunk,
  watchSseStream,
} from '../../../src/services/api/llamacppWatchdog.js'
import type { LlamaCppWatchdogConfig } from '../../../src/llamacppConfig/schema.js'

function makeCfg(over: Partial<LlamaCppWatchdogConfig> = {}): LlamaCppWatchdogConfig {
  return {
    enabled: true,
    interChunk: { enabled: true, gapMs: 1000 },
    reasoning: { enabled: true, blockMs: 2000 },
    tokenCap: {
      enabled: true,
      default: 100,
      memoryPrefetch: 20,
      sideQuery: 50,
      background: 30,
    },
    ...over,
  }
}

describe('layerActive', () => {
  test('master off → 三層都 inactive', () => {
    const cfg = makeCfg({ enabled: false })
    expect(layerActive(cfg, 'interChunk')).toBe(false)
    expect(layerActive(cfg, 'reasoning')).toBe(false)
    expect(layerActive(cfg, 'tokenCap')).toBe(false)
  })

  test('master on + 該層 on → active', () => {
    const cfg = makeCfg()
    expect(layerActive(cfg, 'interChunk')).toBe(true)
  })

  test('master on + 該層 off → inactive', () => {
    const cfg = makeCfg({ interChunk: { enabled: false, gapMs: 1000 } })
    expect(layerActive(cfg, 'interChunk')).toBe(false)
  })
})

describe('getTokenCap', () => {
  test('layer 未啟用 → Infinity', () => {
    const cfg = makeCfg({
      tokenCap: {
        enabled: false,
        default: 100,
        memoryPrefetch: 20,
        sideQuery: 50,
        background: 30,
      },
    })
    expect(getTokenCap(cfg, 'turn')).toBe(Number.POSITIVE_INFINITY)
  })

  test('per call-site 各自值', () => {
    const cfg = makeCfg()
    expect(getTokenCap(cfg, 'turn')).toBe(100)
    expect(getTokenCap(cfg, 'memoryPrefetch')).toBe(20)
    expect(getTokenCap(cfg, 'sideQuery')).toBe(50)
    expect(getTokenCap(cfg, 'background')).toBe(30)
  })
})

describe('chunk inspection', () => {
  test('chunkIsReasoning', () => {
    expect(chunkIsReasoning('{"reasoning_content":"thinking..."}')).toBe(true)
    expect(chunkIsReasoning('{"reasoning_content":""}')).toBe(false)
    expect(chunkIsReasoning('{"content":"x"}')).toBe(false)
  })

  test('chunkIsContent', () => {
    expect(chunkIsContent('{"content":"hello"}')).toBe(true)
    expect(chunkIsContent('{"content":""}')).toBe(false)
    expect(chunkIsContent('{"reasoning_content":"x"}')).toBe(false)
  })

  test('estimateChunkTokens 約等於 char/3', () => {
    // "abcdef" = 6 chars / 3 = 2 tokens
    expect(estimateChunkTokens('{"content":"abcdef"}')).toBe(2)
    // reasoning + content 雙計
    expect(
      estimateChunkTokens('{"reasoning_content":"abc","content":"def"}'),
    ).toBe(2) // (3+3)/3 = 2
  })
})

describe('tickChunk — interChunk', () => {
  test('gap 超過 → abort with interChunk', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    state.lastChunkMs = 1000
    const r = tickChunk(state, null, cfg, 'turn', 1000 + 1500) // 1500ms gap > 1000ms
    expect(r.abort).toBe(true)
    if (r.abort) expect(r.layer).toBe('interChunk')
  })

  test('gap 在範圍內 → no abort', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    state.lastChunkMs = 1000
    const r = tickChunk(state, null, cfg, 'turn', 1500)
    expect(r.abort).toBe(false)
  })

  test('layer disabled → 不檢查', () => {
    const cfg = makeCfg({ interChunk: { enabled: false, gapMs: 100 } })
    const state = createWatchdogState()
    state.lastChunkMs = 0
    const r = tickChunk(state, null, cfg, 'turn', 999_999)
    expect(r.abort).toBe(false)
  })
})

describe('tickChunk — reasoning', () => {
  test('進 reasoning 超 blockMs → abort', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    state.reasoningStartMs = 1000
    state.lastChunkMs = 9000 // 不讓 interChunk 先觸發
    const r = tickChunk(state, null, cfg, 'turn', 1000 + 2500) // 2500ms > 2000ms
    expect(r.abort).toBe(true)
    if (r.abort) expect(r.layer).toBe('reasoning')
  })

  test('未進 reasoning → 不檢查', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    state.reasoningStartMs = null
    const r = tickChunk(state, null, cfg, 'turn', 999_999)
    expect(r.abort).toBe(false)
  })

  test('payload 帶 reasoning_content → 設 reasoningStartMs', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    expect(state.reasoningStartMs).toBeNull()
    tickChunk(state, '{"reasoning_content":"thinking"}', cfg, 'turn', 5000)
    expect(state.reasoningStartMs).toBe(5000)
  })

  test('reasoning 後切 content → 重置 reasoningStartMs', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    state.reasoningStartMs = 5000
    tickChunk(state, '{"content":"answer"}', cfg, 'turn', 6000)
    expect(state.reasoningStartMs).toBeNull()
  })
})

describe('tickChunk — tokenCap', () => {
  test('累積超 ceiling → abort', () => {
    const cfg = makeCfg() // default 100
    const state = createWatchdogState()
    // 餵 一個大 chunk 直接超 cap：300 chars → 100 tokens（剛好等於 cap，不觸發）
    const big = 'x'.repeat(303) // 101 tokens
    const r = tickChunk(
      state,
      `{"content":"${big}"}`,
      cfg,
      'turn',
      Date.now(),
    )
    expect(r.abort).toBe(true)
    if (r.abort) expect(r.layer).toBe('tokenCap')
  })

  test('per call-site 各自上限', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    // memoryPrefetch ceiling = 20 tokens；餵 21 tokens（63 chars）
    const x = 'x'.repeat(63)
    const r = tickChunk(
      state,
      `{"content":"${x}"}`,
      cfg,
      'memoryPrefetch',
      Date.now(),
    )
    expect(r.abort).toBe(true)
    if (r.abort) expect(r.layer).toBe('tokenCap')
  })

  test('未超 → no abort', () => {
    const cfg = makeCfg()
    const state = createWatchdogState()
    const r = tickChunk(state, '{"content":"hi"}', cfg, 'turn', Date.now())
    expect(r.abort).toBe(false)
  })
})

// --- watchSseStream 整合測試 ---

async function* generateChunks(
  chunks: string[],
  delayMs: number = 0,
): AsyncGenerator<string, void, unknown> {
  for (const c of chunks) {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    yield c
  }
}

describe('watchSseStream', () => {
  test('master off → passthrough，不裝 timer', async () => {
    const cfg = makeCfg({ enabled: false })
    const ctrl = new AbortController()
    const out: string[] = []
    for await (const c of watchSseStream(
      generateChunks(['a', 'b', 'c']),
      cfg,
      'turn',
      ctrl,
    )) {
      out.push(c)
    }
    expect(out).toEqual(['a', 'b', 'c'])
  })

  test('正常 stream（5 個 chunk 各 100ms）→ 不誤判', async () => {
    const cfg = makeCfg() // gapMs=1000，足夠
    const ctrl = new AbortController()
    const out: string[] = []
    for await (const c of watchSseStream(
      generateChunks(
        ['{"content":"a"}', '{"content":"b"}', '{"content":"c"}'],
        100,
      ),
      cfg,
      'turn',
      ctrl,
    )) {
      out.push(c)
    }
    expect(out.length).toBe(3)
  })

  test('tokenCap 觸發 → throw WatchdogAbortError，layer=tokenCap', async () => {
    const cfg = makeCfg() // default 100
    const ctrl = new AbortController()
    const big = 'x'.repeat(400) // 134 tokens > 100
    const chunks = [`{"content":"${big}"}`]
    let err: unknown = null
    try {
      for await (const _ of watchSseStream(
        generateChunks(chunks),
        cfg,
        'turn',
        ctrl,
      )) {
        // consume
      }
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(WatchdogAbortError)
    expect((err as WatchdogAbortError).layer).toBe('tokenCap')
    expect(ctrl.signal.aborted).toBe(true)
  })

  test('reasoning watchdog 在 chunk 流中觸發', async () => {
    // blockMs = 100ms，模擬第一個 reasoning chunk 後等 200ms 再來下一個
    const cfg = makeCfg({
      reasoning: { enabled: true, blockMs: 100 },
      interChunk: { enabled: false, gapMs: 1000 },
    })
    const ctrl = new AbortController()
    let err: unknown = null
    try {
      for await (const _ of watchSseStream(
        generateChunks(
          [
            '{"reasoning_content":"thinking..."}',
            '{"reasoning_content":"more..."}', // 200ms 後仍在 reasoning
          ],
          200,
        ),
        cfg,
        'turn',
        ctrl,
      )) {
        // consume
      }
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(WatchdogAbortError)
    expect((err as WatchdogAbortError).layer).toBe('reasoning')
  })

  test('某層 disabled → 該層不觸發', async () => {
    // 關 tokenCap、開大 token chunk → 應通過
    const cfg = makeCfg({
      tokenCap: {
        enabled: false,
        default: 1,
        memoryPrefetch: 1,
        sideQuery: 1,
        background: 1,
      },
    })
    const ctrl = new AbortController()
    const big = 'x'.repeat(400)
    const out: string[] = []
    for await (const c of watchSseStream(
      generateChunks([`{"content":"${big}"}`]),
      cfg,
      'turn',
      ctrl,
    )) {
      out.push(c)
    }
    expect(out.length).toBe(1) // 沒被 abort
  })
})
