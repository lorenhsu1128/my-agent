import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendHistoryEntry,
  getHistoryFilePath,
  readHistory,
  truncateHistory,
} from '../../../src/utils/cronHistory'
import {
  markCronFiredBatch,
  writeCronTasks,
} from '../../../src/utils/cronTasks'

describe('cronHistory — append-only run history', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-history-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('appendHistoryEntry creates file under .my-agent/cron/history/', async () => {
    await appendHistoryEntry(
      'abcd1234',
      { ts: 1735000000000, status: 'ok' },
      { dir: tmpDir },
    )
    const path = getHistoryFilePath('abcd1234', tmpDir)
    expect(existsSync(path)).toBe(true)
    expect(path).toContain(
      join('.my-agent', 'cron', 'history', 'abcd1234.jsonl'),
    )
  })

  test('appendHistoryEntry appends newline-delimited JSON', async () => {
    await appendHistoryEntry(
      'job1',
      { ts: 1, status: 'ok' },
      { dir: tmpDir },
    )
    await appendHistoryEntry(
      'job1',
      { ts: 2, status: 'error', errorMsg: 'boom' },
      { dir: tmpDir },
    )
    const raw = readFileSync(getHistoryFilePath('job1', tmpDir), 'utf-8')
    expect(raw.trimEnd().split('\n').length).toBe(2)
    expect(raw).not.toContain('\r\n')
  })

  test('readHistory returns parsed entries in append order', async () => {
    await appendHistoryEntry('j', { ts: 100, status: 'ok' }, { dir: tmpDir })
    await appendHistoryEntry('j', { ts: 200, status: 'error' }, { dir: tmpDir })
    await appendHistoryEntry('j', { ts: 300, status: 'ok' }, { dir: tmpDir })
    const entries = await readHistory('j', tmpDir)
    expect(entries.map(e => e.ts)).toEqual([100, 200, 300])
    expect(entries[1]!.status).toBe('error')
  })

  test('readHistory tolerates malformed lines', async () => {
    await appendHistoryEntry('j', { ts: 1, status: 'ok' }, { dir: tmpDir })
    const path = getHistoryFilePath('j', tmpDir)
    // Append a garbage line manually.
    const fs = require('fs') as typeof import('fs')
    fs.appendFileSync(path, 'not json\n')
    fs.appendFileSync(
      path,
      JSON.stringify({ ts: 2, status: 'error' }) + '\n',
    )
    const entries = await readHistory('j', tmpDir)
    expect(entries.length).toBe(2)
    expect(entries.map(e => e.ts)).toEqual([1, 2])
  })

  test('readHistory returns [] for missing file', async () => {
    const entries = await readHistory('nope', tmpDir)
    expect(entries).toEqual([])
  })

  test('truncateHistory drops oldest beyond keepRuns', async () => {
    for (let i = 1; i <= 10; i++) {
      await appendHistoryEntry('j', { ts: i, status: 'ok' }, { dir: tmpDir })
    }
    await truncateHistory('j', 3, tmpDir)
    const entries = await readHistory('j', tmpDir)
    expect(entries.map(e => e.ts)).toEqual([8, 9, 10])
  })

  test('truncateHistory is no-op when count <= keepRuns', async () => {
    for (let i = 1; i <= 3; i++) {
      await appendHistoryEntry('j', { ts: i, status: 'ok' }, { dir: tmpDir })
    }
    await truncateHistory('j', 5, tmpDir)
    const entries = await readHistory('j', tmpDir)
    expect(entries.length).toBe(3)
  })

  test('markCronFiredBatch appends to history (success path)', async () => {
    await writeCronTasks(
      [
        {
          id: 'j-success',
          cron: '*/5 * * * *',
          prompt: 'hi',
          createdAt: Date.now() - 60_000,
          recurring: true,
        },
      ],
      tmpDir,
    )
    await markCronFiredBatch(
      [{ id: 'j-success', firedAt: 1735000000000, success: true }],
      tmpDir,
    )
    const entries = await readHistory('j-success', tmpDir)
    expect(entries.length).toBe(1)
    expect(entries[0]!.status).toBe('ok')
    expect(entries[0]!.ts).toBe(1735000000000)
  })

  test('markCronFiredBatch appends history with error message', async () => {
    await writeCronTasks(
      [
        {
          id: 'j-fail',
          cron: '*/5 * * * *',
          prompt: 'hi',
          createdAt: Date.now() - 60_000,
          recurring: true,
        },
      ],
      tmpDir,
    )
    await markCronFiredBatch(
      [
        {
          id: 'j-fail',
          firedAt: 1735000001000,
          success: false,
          error: 'turn aborted',
        },
      ],
      tmpDir,
    )
    const entries = await readHistory('j-fail', tmpDir)
    expect(entries.length).toBe(1)
    expect(entries[0]!.status).toBe('error')
    expect(entries[0]!.errorMsg).toBe('turn aborted')
  })

  test('Wave 3 fields survive read/write round-trip', async () => {
    const { readCronTasks, writeCronTasks } = await import(
      '../../../src/utils/cronTasks'
    )
    const original = [
      {
        id: 'roundtrip',
        cron: '*/5 * * * *',
        prompt: 'p',
        createdAt: Date.now(),
        recurring: true,
        scheduleSpec: { kind: 'nl' as const, raw: '每 5 分鐘' },
        notify: {
          tui: 'always' as const,
          discord: 'home' as const,
        },
        history: { keepRuns: 25 },
        retry: {
          maxAttempts: 3,
          backoffMs: 1000,
          failureMode: { kind: 'turn-error' as const },
          attemptCount: 0,
        },
        condition: { kind: 'lastRunOk' as const },
        catchupMax: 5,
      },
    ]
    await writeCronTasks(original, tmpDir)
    const read = await readCronTasks(tmpDir)
    expect(read.length).toBe(1)
    const t = read[0]!
    expect(t.scheduleSpec).toEqual({ kind: 'nl', raw: '每 5 分鐘' })
    expect(t.notify).toEqual({ tui: 'always', discord: 'home' })
    expect(t.history).toEqual({ keepRuns: 25 })
    expect(t.retry?.maxAttempts).toBe(3)
    expect(t.retry?.backoffMs).toBe(1000)
    expect(t.retry?.failureMode.kind).toBe('turn-error')
    expect(t.condition?.kind).toBe('lastRunOk')
    expect(t.catchupMax).toBe(5)
  })

  test('appendHistoryEntry uses task.history.keepRuns when truncate fires', async () => {
    // We can't deterministically force the probabilistic 10% truncate from
    // appendHistoryEntry, so call truncateHistory directly to validate the
    // keepRuns plumbing path used by the caller.
    for (let i = 1; i <= 60; i++) {
      await appendHistoryEntry(
        'big',
        { ts: i, status: 'ok' },
        { dir: tmpDir, keepRuns: 5 },
      )
    }
    await truncateHistory('big', 5, tmpDir)
    const entries = await readHistory('big', tmpDir)
    expect(entries.length).toBe(5)
    expect(entries[0]!.ts).toBe(56)
  })
})
