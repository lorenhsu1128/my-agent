// B6：CronPicker 純函式層的單元測試。TUI React 渲染部分與專案其他
// picker 一樣不走 ink-testing-library；這個檔覆蓋 sort / label / icon /
// next-fire / last-run / truncate 等邏輯。

import { describe, expect, test } from 'bun:test'
import {
  enrich,
  lastRunLabel,
  nextFireLabel,
  sortEnriched,
  stateIcon,
  taskLabel,
  truncate,
} from '../../../src/commands/cron/cronPickerLogic.js'
import type { CronTask } from '../../../src/utils/cronTasks.js'

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'abcdef12',
    cron: '*/5 * * * *',
    prompt: 'echo hi',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('cronPickerLogic.enrich', () => {
  test('scheduled task gets a nextFireMs', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const e = enrich(task({ cron: '*/5 * * * *' }), now)
    expect(e.nextFireMs).not.toBeNull()
    expect(e.nextFireMs!).toBeGreaterThan(now)
    expect(e.stateRank).toBe(0)
  })

  test('paused task has nextFireMs null + rank 1', () => {
    const e = enrich(task({ state: 'paused' }), Date.now())
    expect(e.nextFireMs).toBeNull()
    expect(e.stateRank).toBe(1)
  })

  test('completed task has nextFireMs null + rank 2', () => {
    const e = enrich(task({ state: 'completed' }), Date.now())
    expect(e.nextFireMs).toBeNull()
    expect(e.stateRank).toBe(2)
  })
})

describe('cronPickerLogic.sortEnriched', () => {
  test('scheduled sorts before paused before completed', () => {
    const now = Date.now()
    const a = enrich(task({ id: 'a', state: 'completed' }), now)
    const b = enrich(task({ id: 'b', state: 'paused' }), now)
    const c = enrich(task({ id: 'c' }), now) // scheduled (default)
    const sorted = [a, b, c].sort(sortEnriched)
    expect(sorted.map(e => e.task.id)).toEqual(['c', 'b', 'a'])
  })

  test('within same state, earliest nextFireMs wins', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const hourly = enrich(task({ id: 'hourly', cron: '0 * * * *' }), now)
    const every5 = enrich(task({ id: 'every5', cron: '*/5 * * * *' }), now)
    const sorted = [hourly, every5].sort(sortEnriched)
    // every5 fires sooner than the next hourly
    expect(sorted[0]!.task.id).toBe('every5')
  })
})

describe('cronPickerLogic.stateIcon', () => {
  test('scheduled with no lastStatus → ✓ green', () => {
    expect(stateIcon(task())).toEqual({ icon: '✓', color: 'green' })
  })
  test('paused → ⏸ yellow', () => {
    expect(stateIcon(task({ state: 'paused' }))).toEqual({
      icon: '⏸',
      color: 'yellow',
    })
  })
  test('completed → ☑ gray', () => {
    expect(stateIcon(task({ state: 'completed' }))).toEqual({
      icon: '☑',
      color: 'gray',
    })
  })
  test('scheduled with lastStatus=error → ✗ red', () => {
    expect(stateIcon(task({ lastStatus: 'error' }))).toEqual({
      icon: '✗',
      color: 'red',
    })
  })
})

describe('cronPickerLogic.taskLabel', () => {
  test('uses name when set', () => {
    expect(taskLabel(task({ name: 'nightly-backup' }))).toBe('nightly-backup')
  })
  test('falls back to first line of prompt', () => {
    expect(taskLabel(task({ prompt: 'line 1\nline 2' }))).toBe('line 1')
  })
  test('truncates long prompts', () => {
    const long = 'x'.repeat(100)
    const label = taskLabel(task({ prompt: long }))
    expect(label.length).toBeLessThanOrEqual(40)
    expect(label.endsWith('...')).toBe(true)
  })
})

describe('cronPickerLogic.nextFireLabel', () => {
  test('paused → "paused"', () => {
    const e = enrich(task({ state: 'paused' }), Date.now())
    expect(nextFireLabel(e, Date.now())).toBe('paused')
  })
  test('completed → "completed"', () => {
    const e = enrich(task({ state: 'completed' }), Date.now())
    expect(nextFireLabel(e, Date.now())).toBe('completed')
  })
  test('scheduled with future time → "in Xh"', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const e = enrich(task({ cron: '0 15 * * *' }), now) // next at 15:00
    const label = nextFireLabel(e, now)
    expect(label).toMatch(/^in /)
  })
  test('overdue → "overdue"', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const e = enrich(task({ cron: '*/5 * * * *' }), now)
    // Pretend "now" advanced past the computed nextFireMs.
    expect(nextFireLabel(e, e.nextFireMs! + 1000)).toBe('overdue')
  })
})

describe('cronPickerLogic.lastRunLabel', () => {
  test('never fired → "never"', () => {
    expect(lastRunLabel(task())).toBe('never')
  })
  test('ok last run → ✓ <duration> ago', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const t = task({
      lastFiredAt: now - 5 * 60_000,
      lastStatus: 'ok',
    })
    expect(lastRunLabel(t, now)).toMatch(/^✓ /)
    expect(lastRunLabel(t, now)).toContain('ago')
  })
  test('error last run → ✗ prefix', () => {
    const now = Date.parse('2026-04-24T10:00:00Z')
    const t = task({ lastFiredAt: now - 60_000, lastStatus: 'error' })
    expect(lastRunLabel(t, now)).toMatch(/^✗ /)
  })
})

describe('cronPickerLogic.truncate', () => {
  test('passthrough when short', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })
  test('clips + ellipsis when long', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })
  test('edge case maxChars=1', () => {
    expect(truncate('abc', 1)).toBe('…')
  })
})
