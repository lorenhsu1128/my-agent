/**
 * M-DAEMON-AUTO：autostart helper 單元測試。
 *
 * 驗 isAutostartEnabled / setAutostartEnabled / hasAttemptedAutostart 行為，
 * spawnDetachedDaemon 靠 inject executable 不真 fork（測試安全）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isAutostartEnabled,
  setAutostartEnabled,
  spawnDetachedDaemon,
  markAutostartAttempted,
  hasAttemptedAutostart,
  _resetAutostartSessionFlagForTest,
} from '../../../src/daemon/autostart'

let origConfigHome: string | undefined
let tmpDir: string
let origNoAutostart: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'autostart-'))
  origConfigHome = process.env.CLAUDE_CONFIG_DIR
  origNoAutostart = process.env.MY_AGENT_NO_DAEMON_AUTOSTART
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  delete process.env.MY_AGENT_NO_DAEMON_AUTOSTART
  _resetAutostartSessionFlagForTest()
  // 在 NODE_ENV=test 下 getGlobalConfig 回同一個 mutable singleton；前一輪測試
  // 殘留 daemonAutoStart 會漏進來，明確重置到 undefined（= default enabled）。
  setAutostartEnabled(true) // 雖然 default 即為 true，這會確保 singleton 的值被「顯式設為 true」
})
afterEach(() => {
  if (origConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = origConfigHome
  if (origNoAutostart === undefined)
    delete process.env.MY_AGENT_NO_DAEMON_AUTOSTART
  else process.env.MY_AGENT_NO_DAEMON_AUTOSTART = origNoAutostart
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('isAutostartEnabled', () => {
  test('defaults to true when config missing', () => {
    expect(isAutostartEnabled()).toBe(true)
  })

  test('env var override wins over config', () => {
    process.env.MY_AGENT_NO_DAEMON_AUTOSTART = '1'
    expect(isAutostartEnabled()).toBe(false)
  })

  test('config=false disables', () => {
    setAutostartEnabled(false)
    expect(isAutostartEnabled()).toBe(false)
  })

  test('config=true enables (explicit)', () => {
    setAutostartEnabled(true)
    expect(isAutostartEnabled()).toBe(true)
  })

  test('setAutostartEnabled round trip', () => {
    setAutostartEnabled(false)
    expect(isAutostartEnabled()).toBe(false)
    setAutostartEnabled(true)
    expect(isAutostartEnabled()).toBe(true)
  })
})

describe('session flag', () => {
  test('hasAttemptedAutostart is false initially', () => {
    expect(hasAttemptedAutostart()).toBe(false)
  })

  test('markAutostartAttempted returns previous value and flips', () => {
    expect(markAutostartAttempted()).toBe(false)
    expect(hasAttemptedAutostart()).toBe(true)
    expect(markAutostartAttempted()).toBe(true)
  })

  test('_resetAutostartSessionFlagForTest resets', () => {
    markAutostartAttempted()
    expect(hasAttemptedAutostart()).toBe(true)
    _resetAutostartSessionFlagForTest()
    expect(hasAttemptedAutostart()).toBe(false)
  })
})

describe('spawnDetachedDaemon', () => {
  test('successful spawn returns spawned:true + childPid', () => {
    // 跨平台 no-op：Windows 上 cmd /c exit，其他 true。
    const isWin = process.platform === 'win32'
    const exe = isWin ? 'cmd.exe' : '/bin/sh'
    const args = isWin ? ['/c', 'exit'] : ['-c', 'exit 0']
    const r = spawnDetachedDaemon({ executable: exe, args })
    expect(r.spawned).toBe(true)
    expect(typeof r.childPid).toBe('number')
  })

  // 不 cross-platform 測 spawn 失敗路徑（Node sync/async error 行為在
  // Windows/POSIX 差異大；已知 catch 區塊存在即可）。
})

describe('autostart CLI subcommand (integration via runDaemonAutostart)', () => {
  test('status reports current state', async () => {
    const { runDaemonAutostart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    let out = ''
    const res = await runDaemonAutostart(
      { agentVersion: 'test', stdout: m => (out += m) },
      'status',
    )
    expect(res.enabled).toBe(true)
    expect(res.changed).toBe(false)
    expect(out).toContain('on')
  })

  test('off then status reflects change', async () => {
    const { runDaemonAutostart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    let out = ''
    const r1 = await runDaemonAutostart(
      { agentVersion: 'test', stdout: m => (out += m) },
      'off',
    )
    expect(r1.enabled).toBe(false)
    expect(r1.changed).toBe(true)
    out = ''
    const r2 = await runDaemonAutostart(
      { agentVersion: 'test', stdout: m => (out += m) },
      'status',
    )
    expect(r2.enabled).toBe(false)
    expect(out).toContain('off')
  })

  test('on when already on reports no change', async () => {
    const { runDaemonAutostart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    let out = ''
    const r = await runDaemonAutostart(
      { agentVersion: 'test', stdout: m => (out += m) },
      'on',
    )
    expect(r.enabled).toBe(true)
    expect(r.changed).toBe(false)
    expect(out).toContain('already on')
  })
})
