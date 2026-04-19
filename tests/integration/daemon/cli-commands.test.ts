/**
 * M-DAEMON-3：daemon CLI subcommand 測試（直接呼叫 handler，不經 commander）。
 *
 * 覆蓋 start / stop / status / logs / restart 的邏輯正確性；child-process 層
 * 的完整 e2e 留給 `tests/integration/daemon/smoke.sh`（M-DAEMON-8）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runDaemonStart,
  runDaemonStop,
  runDaemonStatus,
  runDaemonLogs,
  runDaemonRestart,
} from '../../../src/daemon/daemonCli'
import { readPidFile, writePidFile, PID_SCHEMA_VERSION } from '../../../src/daemon/pidFile'
import { getDaemonPaths } from '../../../src/daemon/paths'

let tmpDir: string
let stdoutCaptured: string
let stderrCaptured: string

const stdout = (m: string): void => {
  stdoutCaptured += m
}
const stderr = (m: string): void => {
  stderrCaptured += m
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'daemon-cli-'))
  stdoutCaptured = ''
  stderrCaptured = ''
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('daemon status', () => {
  test('reports not-running when no pid.json', async () => {
    const s = await runDaemonStatus({
      baseDir: tmpDir,
      agentVersion: 'x',
      stdout,
      stderr,
    })
    expect(s.running).toBe(false)
    expect(s.reason).toBe('missing')
    expect(stdoutCaptured).toContain('not running')
  })

  test('reports stale when pid is dead', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 99_999_999,
        port: 42,
        startedAt: now - 10_000,
        lastHeartbeat: now,
        agentVersion: 'ghost',
      },
      tmpDir,
    )
    const s = await runDaemonStatus(
      {
        baseDir: tmpDir,
        agentVersion: 'x',
        stdout,
        stderr,
      },
      now,
    )
    expect(s.running).toBe(false)
    expect(s.reason).toBe('dead-pid')
    expect(s.pid).toBe(99_999_999)
    expect(stdoutCaptured).toContain('stale')
  })

  test('reports running with details when live', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 54321,
        startedAt: now - 60_000,
        lastHeartbeat: now - 1_000,
        agentVersion: 'live-1.0',
      },
      tmpDir,
    )
    const s = await runDaemonStatus(
      {
        baseDir: tmpDir,
        agentVersion: 'x',
        stdout,
        stderr,
      },
      now,
    )
    expect(s.running).toBe(true)
    expect(s.port).toBe(54321)
    expect(s.uptimeMs).toBe(60_000)
    expect(s.heartbeatAgeMs).toBe(1_000)
    expect(stdoutCaptured).toContain('running')
    expect(stdoutCaptured).toContain('54321')
    expect(stdoutCaptured).toContain('live-1.0')
  })
})

describe('daemon stop', () => {
  test('returns found:false when no daemon exists', async () => {
    const r = await runDaemonStop({
      baseDir: tmpDir,
      agentVersion: 'x',
      stdout,
      stderr,
    })
    expect(r.found).toBe(false)
    expect(r.stopped).toBe(false)
    expect(stdoutCaptured).toContain('no daemon')
  })

  test('returns found:true + stopped:false for stale pid.json', async () => {
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 99_999_999,
        port: 1,
        startedAt: 1,
        lastHeartbeat: 1,
        agentVersion: 'x',
      },
      tmpDir,
    )
    const r = await runDaemonStop({
      baseDir: tmpDir,
      agentVersion: 'x',
      stdout,
      stderr,
    })
    expect(r.found).toBe(true)
    expect(r.stopped).toBe(false)
    expect(stdoutCaptured).toContain('stale')
  })

  test('stops a daemon started via runDaemonStart', async () => {
    // 啟動 daemon（不阻塞）
    const handle = await runDaemonStart(
      {
        baseDir: tmpDir,
        agentVersion: 'test',
        stdout,
        stderr,
      },
      { blockUntilStopped: false },
    )
    // 我們手動停以模擬 `daemon stop` 呼叫的效果
    // 因為實際 runDaemonStop 走 process.kill(pid, 'SIGTERM')，會送到 *自己* 的 process
    // → 單進程測試中那會被本測試的 sigint handler 或 bun test 接住，不可控。
    // 因此此 case 只驗「對一個真實 live daemon 呼叫時不誤報 stale」。
    const liveness = await readPidFile(tmpDir)
    expect(liveness).not.toBeNull()
    expect(liveness?.pid).toBe(process.pid)
    // 我們直接 stop handle 不走 runDaemonStop（避免 SIGTERM 殺自己）
    await handle.stop()
    const after = await readPidFile(tmpDir)
    expect(after).toBeNull()
  })
})

describe('daemon logs', () => {
  test('prints existing log file to stdout', async () => {
    const { logPath } = getDaemonPaths(tmpDir)
    writeFileSync(
      logPath,
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', level: 'info', msg: 'alpha' }) +
        '\n' +
        JSON.stringify({ ts: '2026-01-01T00:00:01Z', level: 'warn', msg: 'beta' }) +
        '\n',
    )
    await runDaemonLogs({
      baseDir: tmpDir,
      agentVersion: 'x',
      stdout,
      stderr,
    })
    expect(stdoutCaptured).toContain('alpha')
    expect(stdoutCaptured).toContain('beta')
  })

  test('reports ENOENT gracefully', async () => {
    await runDaemonLogs({
      baseDir: tmpDir,
      agentVersion: 'x',
      stdout,
      stderr,
    })
    expect(stderrCaptured).toContain('log file not found')
  })

  test('follow mode tails new lines until abort', async () => {
    const { logPath } = getDaemonPaths(tmpDir)
    writeFileSync(logPath, 'line1\n')
    const controller = new AbortController()
    const runPromise = runDaemonLogs(
      {
        baseDir: tmpDir,
        agentVersion: 'x',
        stdout,
        stderr,
      },
      { follow: true, pollIntervalMs: 30, signal: controller.signal },
    )
    // 等第一輪 print 完
    await new Promise(r => setTimeout(r, 80))
    appendFileSync(logPath, 'line2\n')
    await new Promise(r => setTimeout(r, 100))
    appendFileSync(logPath, 'line3\n')
    await new Promise(r => setTimeout(r, 100))
    controller.abort()
    await runPromise
    expect(stdoutCaptured).toContain('line1')
    expect(stdoutCaptured).toContain('line2')
    expect(stdoutCaptured).toContain('line3')
  })
})

describe('daemon start', () => {
  test('starts and returns handle when blockUntilStopped:false', async () => {
    const handle = await runDaemonStart(
      {
        baseDir: tmpDir,
        agentVersion: 'start-test',
        stdout,
        stderr,
      },
      { blockUntilStopped: false, port: 0 },
    )
    expect(handle.server).not.toBeNull()
    expect(handle.server!.port).toBeGreaterThan(0)
    expect(stdoutCaptured).toContain('my-agent daemon started')
    expect(stdoutCaptured).toContain(handle.token.slice(0, 8))
    await handle.stop()
  })

  test('fails cleanly when daemon already running', async () => {
    const first = await runDaemonStart(
      {
        baseDir: tmpDir,
        agentVersion: 'x',
        stdout,
        stderr,
      },
      { blockUntilStopped: false, port: 0 },
    )
    stdoutCaptured = ''
    stderrCaptured = ''
    let threw = false
    try {
      await runDaemonStart(
        {
          baseDir: tmpDir,
          agentVersion: 'y',
          stdout,
          stderr,
        },
        { blockUntilStopped: false, port: 0 },
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(stderrCaptured).toContain('already running')
    await first.stop()
  })
})

describe('daemon restart', () => {
  test('stale pid.json is cleaned before starting new daemon', async () => {
    // 先 seed 一個 stale pid
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 99_999_999,
        port: 1,
        startedAt: 1,
        lastHeartbeat: 1,
        agentVersion: 'ghost',
      },
      tmpDir,
    )
    const handle = await runDaemonRestart(
      {
        baseDir: tmpDir,
        agentVersion: 'fresh',
        stdout,
        stderr,
      },
      { blockUntilStopped: false, port: 0 },
    )
    const cur = await readPidFile(tmpDir)
    expect(cur?.agentVersion).toBe('fresh')
    expect(cur?.pid).toBe(process.pid)
    await handle.stop()
  })
})
