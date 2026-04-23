import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluateCondition } from '../../../src/utils/cronCondition'
import type { CronTask } from '../../../src/utils/cronTasks'

const baseTask = (over: Partial<CronTask> = {}): CronTask => ({
  id: 'test',
  cron: '*/5 * * * *',
  prompt: 'hi',
  createdAt: Date.now(),
  recurring: true,
  ...over,
})

describe('cronCondition — evaluateCondition', () => {
  test('no condition → pass', async () => {
    const r = await evaluateCondition(baseTask())
    expect(r.pass).toBe(true)
    expect(r.reason).toBe('no-condition')
  })

  // --- shell ----------------------------------------------------------------

  test('shell exit 0 → pass', async () => {
    const r = await evaluateCondition(
      baseTask({
        condition: {
          kind: 'shell',
          spec: process.platform === 'win32' ? 'exit /b 0' : 'true',
        },
      }),
    )
    expect(r.pass).toBe(true)
  })

  test('shell exit non-zero → fail', async () => {
    const r = await evaluateCondition(
      baseTask({
        condition: {
          kind: 'shell',
          spec: process.platform === 'win32' ? 'exit /b 1' : 'false',
        },
      }),
    )
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('shell-')
  })

  // --- lastRunOk / lastRunFailed --------------------------------------------

  test('lastRunOk on first fire → pass (default ok)', async () => {
    const r = await evaluateCondition(
      baseTask({ condition: { kind: 'lastRunOk' } }),
    )
    expect(r.pass).toBe(true)
    expect(r.reason).toBe('first-fire-default-ok')
  })

  test('lastRunOk after success → pass', async () => {
    const r = await evaluateCondition(
      baseTask({
        lastStatus: 'ok',
        condition: { kind: 'lastRunOk' },
      }),
    )
    expect(r.pass).toBe(true)
  })

  test('lastRunOk after error → fail', async () => {
    const r = await evaluateCondition(
      baseTask({
        lastStatus: 'error',
        condition: { kind: 'lastRunOk' },
      }),
    )
    expect(r.pass).toBe(false)
  })

  test('lastRunFailed on first fire → fail', async () => {
    const r = await evaluateCondition(
      baseTask({ condition: { kind: 'lastRunFailed' } }),
    )
    expect(r.pass).toBe(false)
  })

  test('lastRunFailed after error → pass', async () => {
    const r = await evaluateCondition(
      baseTask({
        lastStatus: 'error',
        condition: { kind: 'lastRunFailed' },
      }),
    )
    expect(r.pass).toBe(true)
  })

  // --- fileChanged ----------------------------------------------------------

  describe('fileChanged', () => {
    let tmpDir: string
    let watchedFile: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cron-cond-'))
      watchedFile = join(tmpDir, 'watch.txt')
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    test('file missing → fail', async () => {
      const r = await evaluateCondition(
        baseTask({
          condition: { kind: 'fileChanged', path: watchedFile },
        }),
      )
      expect(r.pass).toBe(false)
      expect(r.reason).toBe('file-missing')
    })

    test('file exists but no lastFiredAt → pass (first fire)', async () => {
      writeFileSync(watchedFile, 'a')
      const r = await evaluateCondition(
        baseTask({
          condition: { kind: 'fileChanged', path: watchedFile },
        }),
      )
      expect(r.pass).toBe(true)
      expect(r.reason).toBe('first-fire-file-exists')
    })

    test('mtime > lastFiredAt → pass', async () => {
      writeFileSync(watchedFile, 'a')
      // Set mtime to 1 hour in the future of the lastFiredAt anchor.
      const lastFired = Date.now() - 60_000
      const future = new Date(lastFired + 60 * 60_000)
      utimesSync(watchedFile, future, future)
      const r = await evaluateCondition(
        baseTask({
          lastFiredAt: lastFired,
          condition: { kind: 'fileChanged', path: watchedFile },
        }),
      )
      expect(r.pass).toBe(true)
    })

    test('mtime <= lastFiredAt → fail', async () => {
      writeFileSync(watchedFile, 'a')
      // Set mtime well before lastFiredAt.
      const past = new Date(Date.now() - 2 * 60 * 60_000)
      utimesSync(watchedFile, past, past)
      const r = await evaluateCondition(
        baseTask({
          lastFiredAt: Date.now() - 60_000,
          condition: { kind: 'fileChanged', path: watchedFile },
        }),
      )
      expect(r.pass).toBe(false)
    })
  })

  // --- failure modes --------------------------------------------------------

  test('unknown kind → fail open (pass=true)', async () => {
    const r = await evaluateCondition(
      baseTask({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        condition: { kind: 'bogus', spec: 'x' } as any,
      }),
    )
    expect(r.pass).toBe(true)
    expect(r.reason).toContain('unknown-kind')
  })
})
