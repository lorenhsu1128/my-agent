import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  advanceNextRun,
  markJobRun,
  readCronTasks,
  saveJobOutput,
  writeCronTasks,
} from '../../../src/utils/cronTasks'

describe('cron observability — audit log + markJobRun + advanceNextRun', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-audit-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('saveJobOutput writes under .my-agent/cron/output/{id}/', async () => {
    const file = await saveJobOutput(
      'abcd1234',
      Date.now(),
      '# fire\n\nhello',
      tmpDir,
    )
    expect(existsSync(file)).toBe(true)
    expect(file).toContain(join('.my-agent', 'cron', 'output', 'abcd1234'))
    const content = readFileSync(file, 'utf-8')
    expect(content).toBe('# fire\n\nhello')
  })

  test('markJobRun sets lastStatus on recurring task', async () => {
    await writeCronTasks(
      [
        {
          id: 'aaaa1111',
          cron: '*/5 * * * *',
          prompt: 'do a thing',
          createdAt: Date.now(),
          recurring: true,
          name: 'tester',
        },
      ],
      tmpDir,
    )
    await markJobRun('aaaa1111', true, undefined, tmpDir)
    const tasks = await readCronTasks(tmpDir)
    expect(tasks[0]!.lastStatus).toBe('ok')
    expect(tasks[0]!.name).toBe('tester')
  })

  test('markJobRun with repeat.times=2 deletes after 2 completions', async () => {
    await writeCronTasks(
      [
        {
          id: 'ff00aa11',
          cron: '*/5 * * * *',
          prompt: 'twice only',
          createdAt: Date.now(),
          recurring: true,
          repeat: { times: 2, completed: 0 },
        },
      ],
      tmpDir,
    )
    await markJobRun('ff00aa11', true, undefined, tmpDir)
    let tasks = await readCronTasks(tmpDir)
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.repeat?.completed).toBe(1)

    await markJobRun('ff00aa11', true, undefined, tmpDir)
    tasks = await readCronTasks(tmpDir)
    expect(tasks.length).toBe(0)
  })

  test('markJobRun records lastError on failure', async () => {
    await writeCronTasks(
      [
        {
          id: 'eeee0001',
          cron: '0 9 * * *',
          prompt: 'may fail',
          createdAt: Date.now(),
          recurring: true,
        },
      ],
      tmpDir,
    )
    await markJobRun('eeee0001', false, 'boom', tmpDir)
    const tasks = await readCronTasks(tmpDir)
    expect(tasks[0]!.lastStatus).toBe('error')
    expect(tasks[0]!.lastError).toBe('boom')
  })

  test('advanceNextRun stamps lastFiredAt on recurring task', async () => {
    await writeCronTasks(
      [
        {
          id: 'cccc0001',
          cron: '0 * * * *',
          prompt: 'hourly',
          createdAt: Date.now() - 60_000,
          recurring: true,
        },
      ],
      tmpDir,
    )
    const now = Date.now()
    const advanced = await advanceNextRun('cccc0001', now, tmpDir)
    expect(advanced).toBe(true)
    const tasks = await readCronTasks(tmpDir)
    expect(tasks[0]!.lastFiredAt).toBe(now)
  })

  test('advanceNextRun is a no-op for one-shots', async () => {
    await writeCronTasks(
      [
        {
          id: 'cccc0002',
          cron: '30 14 27 2 *',
          prompt: 'one-shot',
          createdAt: Date.now(),
        },
      ],
      tmpDir,
    )
    const advanced = await advanceNextRun('cccc0002', Date.now(), tmpDir)
    expect(advanced).toBe(false)
  })

  test('writeCronTasks is atomic (tempfile leaves no cron file if rename fails on nonexistent parent?)', async () => {
    // Sanity: normal happy path — just verify resulting file matches input.
    const tasks = [
      {
        id: 'atom0001',
        cron: '0 9 * * *',
        prompt: 'atomic test',
        createdAt: Date.now(),
        recurring: true as const,
      },
    ]
    await writeCronTasks(tasks, tmpDir)
    const roundTripped = await readCronTasks(tmpDir)
    expect(roundTripped[0]!.id).toBe('atom0001')
    expect(roundTripped[0]!.prompt).toBe('atomic test')
  })
})
