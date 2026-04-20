/**
 * Stale `.daemon.lock` take-over — previous daemon crashed without cleanup 不應
 * 讓後續 spawn 永遠失敗。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beginDaemonSession } from '../../../src/daemon/sessionWriter'

let origConfigDir: string | undefined
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stale-lock-'))
  origConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})
afterEach(() => {
  if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = origConfigDir
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('beginDaemonSession stale lock detection', () => {
  test('dead pid in lock → taken over', () => {
    // Seed lock pointing at a non-existent pid.
    const { getProjectDir } = require('../../../src/utils/sessionStorage')
    const projectDir = getProjectDir(process.cwd())
    mkdirSync(projectDir, { recursive: true })
    const lockPath = join(projectDir, '.daemon.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99_999_999, startedAt: 1 }) + '\n',
    )
    expect(existsSync(lockPath)).toBe(true)

    const handle = beginDaemonSession({ cwd: process.cwd() })
    try {
      expect(handle.lockPath).toBe(lockPath)
      // Lock 被重寫為當前 process 的 pid
      const current = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
        pid: number
      }
      expect(current.pid).toBe(process.pid)
    } finally {
      handle.dispose()
    }
  })

  test('live pid in lock → real conflict, throws', () => {
    const { getProjectDir } = require('../../../src/utils/sessionStorage')
    const projectDir = getProjectDir(process.cwd())
    mkdirSync(projectDir, { recursive: true })
    const lockPath = join(projectDir, '.daemon.lock')
    // Use the current process pid (definitely alive).
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: 1 }) + '\n',
    )
    let threw = false
    try {
      beginDaemonSession({ cwd: process.cwd() })
    } catch (e) {
      threw = true
      expect(String(e)).toContain('live pid')
    }
    expect(threw).toBe(true)
    // Lock 應保留不動
    expect(existsSync(lockPath)).toBe(true)
  })

  test('malformed lock → treated as stale and taken over', () => {
    const { getProjectDir } = require('../../../src/utils/sessionStorage')
    const projectDir = getProjectDir(process.cwd())
    mkdirSync(projectDir, { recursive: true })
    const lockPath = join(projectDir, '.daemon.lock')
    writeFileSync(lockPath, 'not-json-at-all')
    const handle = beginDaemonSession({ cwd: process.cwd() })
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
        pid: number
      }
      expect(current.pid).toBe(process.pid)
    } finally {
      handle.dispose()
    }
  })
})
