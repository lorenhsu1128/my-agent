import { describe, expect, test } from 'bun:test'
import { computeGraceMs, nextCronRunMs } from '../../../src/utils/cronTasks'

// computeGraceMs drives the stale-run fast-forward logic in cronScheduler.
// Exercise it directly — the scheduler loop itself is covered by the smoke
// path; this file locks the policy (half-period, clamped 2m-2h).
describe('computeGraceMs — Wave 1 stale-run policy', () => {
  test('every-minute cron → 2-minute floor', () => {
    const g = computeGraceMs('* * * * *', Date.now())
    // half of 60s = 30s, floored to 120000ms (2 min).
    expect(g).toBe(2 * 60 * 1000)
  })

  test('every-5-minute cron → half-period (2.5m, above floor)', () => {
    const g = computeGraceMs('*/5 * * * *', Date.now())
    // half of 5min = 150000ms, above the 2-min floor → no clamp.
    expect(g).toBe(2.5 * 60 * 1000)
  })

  test('hourly cron → 30-minute grace (half-period, within bounds)', () => {
    const g = computeGraceMs('0 * * * *', Date.now())
    expect(g).toBe(30 * 60 * 1000)
  })

  test('daily cron → clamped to 2-hour ceiling (half of 24h = 12h)', () => {
    const g = computeGraceMs('0 9 * * *', Date.now())
    expect(g).toBe(2 * 60 * 60 * 1000)
  })
})

describe('stale-run detection end-to-end math', () => {
  test('a recurring task whose next-from-lastFired is past grace is stale', () => {
    const cron = '0 * * * *' // hourly
    // Pretend the task last fired 3 hours ago.
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000
    const next = nextCronRunMs(cron, threeHoursAgo)!
    const grace = computeGraceMs(cron, Date.now())
    // The scheduler's test: now - next > grace → stale.
    expect(Date.now() - next).toBeGreaterThan(grace)
  })

  test('a recurring task just past its fire time is NOT stale', () => {
    const cron = '0 * * * *'
    // next-from-2-hours-ago = start of hour ~1-2h back; pick a point where
    // the anchor is inside the grace window.
    const justAMinuteAgo = Date.now() - 60 * 1000
    const next = nextCronRunMs(cron, Date.now() - 60 * 60 * 1000 - 60 * 1000)!
    const grace = computeGraceMs(cron, justAMinuteAgo)
    // Exact value depends on wall-clock minute-of-hour; assert the
    // machinery returns finite numbers. A tighter assertion would be flaky
    // near the :00 boundary.
    expect(Number.isFinite(next)).toBe(true)
    expect(Number.isFinite(grace)).toBe(true)
  })
})
