import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readCronTasks,
  updateCronTask,
  writeCronTasks,
} from '../../../src/utils/cronTasks'

describe('cron lifecycle — Wave 2 updateCronTask helper', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-lifecycle-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('updateCronTask mutates file-backed task and persists', async () => {
    await writeCronTasks(
      [
        {
          id: 'life0001',
          cron: '0 9 * * *',
          prompt: 'old prompt',
          createdAt: Date.now(),
          recurring: true,
        },
      ],
      tmpDir,
    )
    const updated = await updateCronTask(
      'life0001',
      t => ({ ...t, prompt: 'new prompt', name: 'renamed' }),
      tmpDir,
    )
    expect(updated?.prompt).toBe('new prompt')
    expect(updated?.name).toBe('renamed')
    const reread = await readCronTasks(tmpDir)
    expect(reread[0]!.prompt).toBe('new prompt')
    expect(reread[0]!.name).toBe('renamed')
  })

  test('updateCronTask returns null for missing id', async () => {
    await writeCronTasks([], tmpDir)
    const res = await updateCronTask(
      'ghost001',
      t => t,
      tmpDir,
    )
    expect(res).toBeNull()
  })

  test('pause → file state flips to paused with pausedAt timestamp', async () => {
    await writeCronTasks(
      [
        {
          id: 'pause001',
          cron: '*/5 * * * *',
          prompt: 'work',
          createdAt: Date.now(),
          recurring: true,
        },
      ],
      tmpDir,
    )
    const pausedAt = new Date().toISOString()
    await updateCronTask(
      'pause001',
      t => ({ ...t, state: 'paused', pausedAt }),
      tmpDir,
    )
    const reread = await readCronTasks(tmpDir)
    expect(reread[0]!.state).toBe('paused')
    expect(reread[0]!.pausedAt).toBe(pausedAt)
  })

  test('resume → state clears back to scheduled and pausedAt drops', async () => {
    await writeCronTasks(
      [
        {
          id: 'resm001',
          cron: '*/5 * * * *',
          prompt: 'work',
          createdAt: Date.now(),
          recurring: true,
          state: 'paused',
          pausedAt: new Date().toISOString(),
        },
      ],
      tmpDir,
    )
    await updateCronTask(
      'resm001',
      t => {
        const { pausedAt: _paused, ...rest } = t
        return { ...rest, state: 'scheduled' }
      },
      tmpDir,
    )
    const reread = await readCronTasks(tmpDir)
    expect(reread[0]!.state).toBe('scheduled')
    expect(reread[0]!.pausedAt).toBeUndefined()
  })

  test('schema round-trips modelOverride + preRunScript', async () => {
    await writeCronTasks(
      [
        {
          id: 'over0001',
          cron: '0 * * * *',
          prompt: 'hourly',
          createdAt: Date.now(),
          recurring: true,
          modelOverride: 'claude-opus-4-7',
          preRunScript: 'date',
        },
      ],
      tmpDir,
    )
    const reread = await readCronTasks(tmpDir)
    expect(reread[0]!.modelOverride).toBe('claude-opus-4-7')
    expect(reread[0]!.preRunScript).toBe('date')
  })
})
