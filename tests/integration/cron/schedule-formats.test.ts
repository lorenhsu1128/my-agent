import { describe, expect, test } from 'bun:test'
import { parseSchedule } from '../../../src/utils/cronTasks'

describe('parseSchedule — Wave 1 DSL', () => {
  test('plain 5-field cron passes through', () => {
    const r = parseSchedule('0 9 * * 1-5')
    expect(r.cron).toBe('0 9 * * 1-5')
    expect(r.recurring).toBe(true)
  })

  test('duration "30m" → one-shot cron 30 minutes from now', () => {
    const before = Date.now()
    const r = parseSchedule('30m')
    expect(r.recurring).toBe(false)
    // Cron fields reconstruct a point 30 minutes away; sanity-check: cron
    // has 5 fields and corresponds to some future datetime.
    const parts = r.cron.split(/\s+/)
    expect(parts.length).toBe(5)
    expect(parts[4]).toBe('*')
    // The display string should mention the original input.
    expect(r.display).toContain('30m')
    expect(Date.now() - before).toBeLessThan(1000)
  })

  test('interval "every 5m" → */5 * * * *', () => {
    const r = parseSchedule('every 5m')
    expect(r.cron).toBe('*/5 * * * *')
    expect(r.recurring).toBe(true)
  })

  test('interval "every 2h" → 0 */2 * * *', () => {
    const r = parseSchedule('every 2h')
    expect(r.cron).toBe('0 */2 * * *')
    expect(r.recurring).toBe(true)
  })

  test('interval "every 1d" → 0 0 * * *', () => {
    const r = parseSchedule('every 1d')
    expect(r.cron).toBe('0 0 * * *')
    expect(r.recurring).toBe(true)
  })

  test('ISO timestamp in future → one-shot', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const iso = future.toISOString().slice(0, 16) // YYYY-MM-DDTHH:MM
    const r = parseSchedule(iso)
    expect(r.recurring).toBe(false)
    const parts = r.cron.split(/\s+/)
    expect(parts.length).toBe(5)
  })

  test('rejects interval that does not divide hour', () => {
    expect(() => parseSchedule('every 45m')).toThrow()
  })

  test('rejects past ISO timestamp', () => {
    expect(() => parseSchedule('2000-01-01T00:00')).toThrow()
  })

  test('rejects garbage', () => {
    expect(() => parseSchedule('not a schedule')).toThrow()
  })

  test('rejects empty', () => {
    expect(() => parseSchedule('')).toThrow()
  })
})
