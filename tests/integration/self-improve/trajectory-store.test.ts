import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  writeTrajectory,
  readTrajectories,
  pruneTrajectories,
} from '../../../src/services/selfImprove/trajectoryStore'

describe('trajectoryStore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'trajectory-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('writeTrajectory 建立正確的檔案結構', async () => {
    await writeTrajectory(tempDir, '2026-04-17', {
      attempted: 'deploy feature X',
      succeeded: ['typecheck', 'tests'],
      failed: [],
      toolSequences: ['Read → Edit → Bash(bun test)'],
      lessons: ['Always run typecheck before tests'],
    })
    const { readFile } = await import('fs/promises')
    const content = await readFile(
      join(tempDir, 'trajectories', '2026-04-17.md'),
      'utf-8',
    )
    expect(content).toContain('deploy feature X')
    expect(content).toContain('typecheck')
    expect(content).toContain('Always run typecheck before tests')
  })

  test('readTrajectories 讀取最近 N 天', async () => {
    await writeTrajectory(tempDir, '2026-04-15', { attempted: 'day1' })
    await writeTrajectory(tempDir, '2026-04-16', { attempted: 'day2' })
    await writeTrajectory(tempDir, '2026-04-17', { attempted: 'day3' })
    const results = await readTrajectories(tempDir, 2)
    expect(results).toHaveLength(2)
    // Most recent first
    expect(results[0]).toContain('day3')
    expect(results[1]).toContain('day2')
  })

  test('pruneTrajectories 清理舊軌跡', async () => {
    await writeTrajectory(tempDir, '2026-03-01', { attempted: 'old' })
    await writeTrajectory(tempDir, '2026-03-15', { attempted: 'mid' })
    await writeTrajectory(tempDir, '2026-04-17', { attempted: 'new' })
    const removed = await pruneTrajectories(tempDir, 1)
    expect(removed).toBe(2)
    const files = await readdir(join(tempDir, 'trajectories'))
    expect(files).toHaveLength(1)
    expect(files[0]).toBe('2026-04-17.md')
  })
})
