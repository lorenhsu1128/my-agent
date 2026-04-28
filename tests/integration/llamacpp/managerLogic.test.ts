// M-LLAMACPP-WATCHDOG Phase 3-9：llamacppManagerLogic + argsParser 純函式測試。

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WATCHDOG_CONFIG,
  TABS,
  WATCHDOG_FIELDS,
  formatMs,
  formatTokens,
  getFieldSpec,
  isLayerEffective,
  nextTab,
  parseCallSiteSuffix,
  prevTab,
  resetWatchdog,
  turnAllOff,
  turnAllOn,
} from '../../../src/commands/llamacpp/llamacppManagerLogic.js'
import {
  HELP_TEXT,
  parseLlamacppArgs,
} from '../../../src/commands/llamacpp/argsParser.js'

describe('TABS / nextTab / prevTab', () => {
  test('3 tabs (M-LLAMACPP-REMOTE 加 endpoints)', () => {
    expect(TABS.map(t => t.id)).toEqual(['watchdog', 'slots', 'endpoints'])
  })
  test('cycle', () => {
    expect(nextTab('watchdog')).toBe('slots')
    expect(nextTab('slots')).toBe('endpoints')
    expect(nextTab('endpoints')).toBe('watchdog')
    expect(prevTab('watchdog')).toBe('endpoints')
    expect(prevTab('endpoints')).toBe('slots')
  })
})

describe('WATCHDOG_FIELDS / getFieldSpec', () => {
  test('10 fields', () => {
    expect(WATCHDOG_FIELDS.length).toBe(10)
  })
  test('toggle / number 各自 spec', () => {
    expect(getFieldSpec('master.enabled').kind).toBe('toggle')
    expect(getFieldSpec('reasoning.blockMs').kind).toBe('number')
  })
  test('未知 id throw', () => {
    expect(() => getFieldSpec('x' as never)).toThrow()
  })
})

describe('isLayerEffective (master AND layer)', () => {
  test('master off → 全 inactive', () => {
    const c = { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
    expect(isLayerEffective(c, 'interChunk')).toBe(false)
    expect(isLayerEffective(c, 'reasoning')).toBe(false)
    expect(isLayerEffective(c, 'tokenCap')).toBe(false)
  })
  test('master on + layer on → active', () => {
    const c = turnAllOn(DEFAULT_WATCHDOG_CONFIG)
    expect(isLayerEffective(c, 'interChunk')).toBe(true)
    expect(isLayerEffective(c, 'reasoning')).toBe(true)
    expect(isLayerEffective(c, 'tokenCap')).toBe(true)
  })
  test('master on + layer off → inactive', () => {
    const c = {
      ...DEFAULT_WATCHDOG_CONFIG,
      enabled: true,
      interChunk: { ...DEFAULT_WATCHDOG_CONFIG.interChunk, enabled: false },
    }
    expect(isLayerEffective(c, 'interChunk')).toBe(false)
  })
})

describe('turnAllOn / turnAllOff / resetWatchdog', () => {
  test('turnAllOn 不改數值', () => {
    const before = {
      ...DEFAULT_WATCHDOG_CONFIG,
      reasoning: { enabled: false, blockMs: 99_999 },
    }
    const after = turnAllOn(before)
    expect(after.enabled).toBe(true)
    expect(after.reasoning.enabled).toBe(true)
    expect(after.reasoning.blockMs).toBe(99_999) // 數值保留
  })
  test('turnAllOff 不改數值', () => {
    const before = turnAllOn({
      ...DEFAULT_WATCHDOG_CONFIG,
      tokenCap: {
        ...DEFAULT_WATCHDOG_CONFIG.tokenCap,
        memoryPrefetch: 999,
      },
    })
    const after = turnAllOff(before)
    expect(after.enabled).toBe(false)
    expect(after.tokenCap.memoryPrefetch).toBe(999)
  })
  test('reset → DEFAULT', () => {
    expect(resetWatchdog()).toEqual(DEFAULT_WATCHDOG_CONFIG)
  })
})

describe('parseCallSiteSuffix', () => {
  test('不分大小寫', () => {
    expect(parseCallSiteSuffix('default')).toBe('turn')
    expect(parseCallSiteSuffix('TURN')).toBe('turn')
    expect(parseCallSiteSuffix('memoryPrefetch')).toBe('memoryPrefetch')
    expect(parseCallSiteSuffix('SIDEQUERY')).toBe('sideQuery')
    expect(parseCallSiteSuffix('background')).toBe('background')
    expect(parseCallSiteSuffix('xyz')).toBe(null)
  })
})

describe('format helpers', () => {
  test('formatMs', () => {
    expect(formatMs(500)).toBe('500 ms')
    expect(formatMs(30_000)).toBe('30 s')
    expect(formatMs(120_500)).toBe('120.5 s')
  })
  test('formatTokens', () => {
    expect(formatTokens(256)).toBe('256')
    expect(formatTokens(16_000)).toBe('16k')
    expect(formatTokens(4_500)).toBe('4.5k')
  })
})

describe('parseLlamacppArgs — empty / help / errors', () => {
  test('empty / whitespace → tui', () => {
    expect(parseLlamacppArgs('').kind).toBe('tui')
    expect(parseLlamacppArgs('   ').kind).toBe('tui')
  })
  test('help', () => {
    expect(parseLlamacppArgs('help').kind).toBe('help')
    expect(parseLlamacppArgs('--help').kind).toBe('help')
  })
  test('unknown head → error', () => {
    const r = parseLlamacppArgs('foobar')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('foobar')
  })
})

describe('parseLlamacppArgs — watchdog mutations', () => {
  test('watchdog → status', () => {
    expect(parseLlamacppArgs('watchdog').kind).toBe('watchdog-status')
  })
  test('watchdog enable / disable', () => {
    const r1 = parseLlamacppArgs('watchdog enable')
    expect(r1.kind).toBe('watchdog-master')
    if (r1.kind === 'watchdog-master') expect(r1.enabled).toBe(true)
    const r2 = parseLlamacppArgs('watchdog disable')
    expect(r2.kind).toBe('watchdog-master')
    if (r2.kind === 'watchdog-master') expect(r2.enabled).toBe(false)
  })
  test('watchdog A on / off', () => {
    const r = parseLlamacppArgs('watchdog A on')
    expect(r.kind).toBe('watchdog-toggle')
    if (r.kind === 'watchdog-toggle') {
      expect(r.field).toBe('interChunk.enabled')
      expect(r.enabled).toBe(true)
    }
  })
  test('watchdog B 180000 → set number', () => {
    const r = parseLlamacppArgs('watchdog B 180000')
    expect(r.kind).toBe('watchdog-set-number')
    if (r.kind === 'watchdog-set-number') {
      expect(r.field).toBe('reasoning.blockMs')
      expect(r.value).toBe(180000)
    }
  })
  test('watchdog C.background 8000', () => {
    const r = parseLlamacppArgs('watchdog C.background 8000')
    expect(r.kind).toBe('watchdog-set-number')
    if (r.kind === 'watchdog-set-number') {
      expect(r.field).toBe('tokenCap.background')
      expect(r.value).toBe(8000)
    }
  })
  test('watchdog all on / off', () => {
    expect(parseLlamacppArgs('watchdog all on')).toEqual({
      kind: 'watchdog-all',
      on: true,
      session: false,
    })
    expect(parseLlamacppArgs('watchdog all off')).toEqual({
      kind: 'watchdog-all',
      on: false,
      session: false,
    })
  })
  test('watchdog reset', () => {
    expect(parseLlamacppArgs('watchdog reset').kind).toBe('watchdog-reset')
  })
  test('--session flag 抽出', () => {
    const r = parseLlamacppArgs('watchdog --session A on')
    expect(r.kind).toBe('watchdog-toggle')
    if (r.kind === 'watchdog-toggle') {
      expect(r.session).toBe(true)
      expect(r.field).toBe('interChunk.enabled')
    }
  })
  test('-s flag 同等 --session', () => {
    const r = parseLlamacppArgs('watchdog -s reset')
    expect(r.kind).toBe('watchdog-reset')
    if (r.kind === 'watchdog-reset') expect(r.session).toBe(true)
  })
  test('A 後面接負數 / 非數字 → error', () => {
    expect(parseLlamacppArgs('watchdog A xyz').kind).toBe('error')
    expect(parseLlamacppArgs('watchdog B -100').kind).toBe('error')
  })
})

describe('parseLlamacppArgs — slots', () => {
  test('slots → status', () => {
    expect(parseLlamacppArgs('slots').kind).toBe('slots-status')
  })
  test('slots kill 1', () => {
    const r = parseLlamacppArgs('slots kill 1')
    expect(r.kind).toBe('slots-kill')
    if (r.kind === 'slots-kill') expect(r.slotId).toBe(1)
  })
  test('slots kill abc → error', () => {
    expect(parseLlamacppArgs('slots kill abc').kind).toBe('error')
  })
})

describe('HELP_TEXT', () => {
  test('涵蓋主要動詞', () => {
    expect(HELP_TEXT).toContain('watchdog')
    expect(HELP_TEXT).toContain('slots')
    expect(HELP_TEXT).toContain('--session')
    expect(HELP_TEXT).toContain('reset')
  })
})
