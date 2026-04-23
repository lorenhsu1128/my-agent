import { describe, expect, test } from 'bun:test'
import {
  enumerateMissedFires,
  selectCatchUpFires,
  type CronTask,
} from '../../../src/utils/cronTasks'

const t = (over: Partial<CronTask> = {}): CronTask => ({
  id: 'x',
  cron: '0 * * * *',
  prompt: 'hi',
  createdAt: 0,
  recurring: true,
  ...over,
})

describe('cronTasks — Wave 3 catch-up helpers', () => {
  // --- enumerateMissedFires --------------------------------------------------

  test('enumerateMissedFires zero when anchor === now', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(enumerateMissedFires('0 * * * *', now, now)).toBe(0)
  })

  test('enumerateMissedFires counts hourly fires across 5 hours', () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 30, 0) // 00:30
    const now = Date.UTC(2026, 0, 1, 5, 30, 0) // 05:30 — 5 hourly fires
    // hourly cron "0 * * * *" fires at 01:00 02:00 03:00 04:00 05:00
    expect(enumerateMissedFires('0 * * * *', anchor, now)).toBe(5)
  })

  test('enumerateMissedFires returns 0 when next fire is in the future', () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 0, 0)
    const now = Date.UTC(2026, 0, 1, 0, 30, 0) // before next 01:00
    expect(enumerateMissedFires('0 * * * *', anchor, now)).toBe(0)
  })

  test('enumerateMissedFires across day boundary', () => {
    const anchor = Date.UTC(2026, 0, 1, 22, 0, 0)
    const now = Date.UTC(2026, 0, 2, 2, 0, 0)
    // hourly: 23:00 00:00 01:00 02:00 = 4 fires
    expect(enumerateMissedFires('0 * * * *', anchor, now)).toBe(4)
  })

  test('enumerateMissedFires returns 0 for invalid cron', () => {
    expect(enumerateMissedFires('not a cron', 0, Date.now())).toBe(0)
  })

  test('enumerateMissedFires caps at MAX_ENUMERATE for pathological case', () => {
    // every-minute cron over a year ago → would be ~525,600 iterations
    const anchor = Date.UTC(2025, 0, 1, 0, 0, 0)
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const count = enumerateMissedFires('* * * * *', anchor, now)
    expect(count).toBe(10_000)
  })

  // --- selectCatchUpFires ----------------------------------------------------

  test('selectCatchUpFires defaults to min(missed, 1)', () => {
    expect(selectCatchUpFires(t(), 0)).toBe(0)
    expect(selectCatchUpFires(t(), 1)).toBe(1)
    expect(selectCatchUpFires(t(), 5)).toBe(1)
  })

  test('selectCatchUpFires honors catchupMax = 0 (skip all)', () => {
    expect(selectCatchUpFires(t({ catchupMax: 0 }), 5)).toBe(0)
  })

  test('selectCatchUpFires honors catchupMax = 3', () => {
    expect(selectCatchUpFires(t({ catchupMax: 3 }), 1)).toBe(1)
    expect(selectCatchUpFires(t({ catchupMax: 3 }), 5)).toBe(3)
    expect(selectCatchUpFires(t({ catchupMax: 3 }), 0)).toBe(0)
  })

  test('selectCatchUpFires floors fractional catchupMax', () => {
    expect(selectCatchUpFires(t({ catchupMax: 2.7 }), 5)).toBe(2)
  })

  test('selectCatchUpFires treats negative catchupMax as 0', () => {
    expect(selectCatchUpFires(t({ catchupMax: -1 }), 5)).toBe(0)
  })
})
