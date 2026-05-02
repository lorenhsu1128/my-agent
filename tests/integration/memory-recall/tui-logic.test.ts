// M-MEMRECALL-CMD：MemoryRecallManager 純函式邏輯測試。

import { describe, expect, test } from 'bun:test'
import {
  clampRange,
  filterRecall,
  formatHHMM,
  formatRow,
  nextField,
  NUMBER_RANGE,
  prevField,
  SETTINGS_FIELDS,
  type SettingsField,
} from '../../../src/commands/memory-recall/memoryRecallLogic.js'

describe('clampRange', () => {
  test('在範圍內回原值', () => {
    expect(clampRange(5, 8)).toBe(5)
    expect(clampRange(NUMBER_RANGE.min, 8)).toBe(NUMBER_RANGE.min)
    expect(clampRange(NUMBER_RANGE.max, 8)).toBe(NUMBER_RANGE.max)
  })
  test('超出 → clamp 到邊界', () => {
    expect(clampRange(0, 8)).toBe(NUMBER_RANGE.min)
    expect(clampRange(100, 8)).toBe(NUMBER_RANGE.max)
    expect(clampRange(-3, 8)).toBe(NUMBER_RANGE.min)
  })
  test('小數 → round', () => {
    expect(clampRange(5.7, 8)).toBe(6)
    expect(clampRange(5.3, 8)).toBe(5)
  })
  test('NaN / Infinity → fallback', () => {
    expect(clampRange(NaN, 8)).toBe(8)
    expect(clampRange(Infinity, 8)).toBe(8)
    expect(clampRange(-Infinity, 8)).toBe(8)
  })
})

describe('nextField / prevField (環狀)', () => {
  test('正向循環', () => {
    let f: SettingsField = 'enabled'
    for (let i = 0; i < SETTINGS_FIELDS.length; i++) f = nextField(f)
    expect(f).toBe('enabled')
  })
  test('反向循環', () => {
    let f: SettingsField = 'enabled'
    for (let i = 0; i < SETTINGS_FIELDS.length; i++) f = prevField(f)
    expect(f).toBe('enabled')
  })
  test('next 三步穿過所有欄位', () => {
    expect(nextField('enabled')).toBe('maxFiles')
    expect(nextField('maxFiles')).toBe('fallbackMaxFiles')
    expect(nextField('fallbackMaxFiles')).toBe('enabled')
  })
})

describe('filterRecall', () => {
  const entries = [
    { path: '/m/foo.md', ts: 1, hitCount: 1, source: 'selector' as const },
    { path: '/m/bar.md', ts: 2, hitCount: 2, source: 'selector' as const },
    { path: '/m/baz_qux.md', ts: 3, hitCount: 3, source: 'fallback' as const },
  ]
  test('空 keyword → 原列', () => {
    expect(filterRecall(entries, '')).toEqual(entries)
    expect(filterRecall(entries, '   ')).toEqual(entries)
  })
  test('單一 keyword 配 basename', () => {
    const r = filterRecall(entries, 'bar')
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe('/m/bar.md')
  })
  test('keyword 不分大小寫', () => {
    const r = filterRecall(entries, 'QUX')
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe('/m/baz_qux.md')
  })
  test('沒命中 → 空 array', () => {
    expect(filterRecall(entries, 'zzz')).toEqual([])
  })
})

describe('formatHHMM', () => {
  test('格式為 HH:MM 兩位數', () => {
    const ts = new Date(2026, 4, 2, 9, 5).getTime()
    expect(formatHHMM(ts)).toBe('09:05')
  })
  test('23:59 邊界', () => {
    const ts = new Date(2026, 4, 2, 23, 59).getTime()
    expect(formatHHMM(ts)).toBe('23:59')
  })
})

describe('formatRow', () => {
  test('basic：basename + 命中 + 時刻', () => {
    const ts = new Date(2026, 4, 2, 9, 5).getTime()
    const out = formatRow(
      { path: '/m/foo.md', ts, hitCount: 3, source: 'selector' },
      30,
    )
    expect(out).toContain('foo.md')
    expect(out).toContain('3×')
    expect(out).toContain('09:05')
    expect(out).not.toContain('(fallback)')
  })
  test('fallback 標註', () => {
    const ts = new Date(2026, 4, 2, 12, 0).getTime()
    const out = formatRow(
      { path: '/m/x.md', ts, hitCount: 1, source: 'fallback' },
      30,
    )
    expect(out).toContain('(fallback)')
  })
  test('長 basename 截斷加 …', () => {
    const ts = Date.now()
    const longName = 'a'.repeat(100) + '.md'
    const out = formatRow(
      { path: `/m/${longName}`, ts, hitCount: 1, source: 'selector' },
      20,
    )
    // 限制在 maxName 寬度內 + 1 個 …
    expect(out).toContain('…')
  })
})
