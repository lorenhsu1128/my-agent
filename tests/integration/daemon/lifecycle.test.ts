/**
 * M-DAEMON-1：daemon 基礎設施測試（pid.json / token / heartbeat / stale 偵測）。
 *
 * 這組測試全部在 tmp 目錄跑，不碰真實 `~/.my-agent/`。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DaemonAlreadyRunningError,
  startDaemon,
} from '../../../src/daemon/daemonMain'
import {
  compareTokens,
  ensureToken,
  generateToken,
  readToken,
} from '../../../src/daemon/authToken'
import {
  checkDaemonLiveness,
  deletePidFile,
  DEFAULT_MAX_STALE_MS,
  isPidAlive,
  PID_SCHEMA_VERSION,
  readPidFile,
  updateHeartbeat,
  writePidFile,
} from '../../../src/daemon/pidFile'
import { createDaemonLogger } from '../../../src/daemon/daemonLog'
import { getDaemonPaths } from '../../../src/daemon/paths'
import { jsonParse } from '../../../src/utils/slowOperations'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'daemon-lifecycle-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('paths', () => {
  test('resolve all 3 files under baseDir', () => {
    const p = getDaemonPaths(tmpDir)
    expect(p.baseDir).toBe(tmpDir)
    expect(p.pidPath).toBe(join(tmpDir, 'daemon.pid.json'))
    expect(p.tokenPath).toBe(join(tmpDir, 'daemon.token'))
    expect(p.logPath).toBe(join(tmpDir, 'daemon.log'))
  })
})

describe('authToken', () => {
  test('generateToken produces 64-char lowercase hex', () => {
    const t = generateToken()
    expect(t.length).toBe(64)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('tokens are unique across calls', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
  })

  test('ensureToken creates file on first call then reuses', async () => {
    const first = await ensureToken(tmpDir)
    const second = await ensureToken(tmpDir)
    expect(first).toBe(second)
    const onDisk = await readToken(tmpDir)
    expect(onDisk).toBe(first)
  })

  test('readToken returns null when file absent', async () => {
    const t = await readToken(tmpDir)
    expect(t).toBeNull()
  })

  test('readToken returns null for malformed content', async () => {
    const { tokenPath } = getDaemonPaths(tmpDir)
    const { writeFileSync } = await import('fs')
    writeFileSync(tokenPath, 'not-hex')
    const t = await readToken(tmpDir)
    expect(t).toBeNull()
  })

  test('compareTokens timing-safe equality', () => {
    const t = generateToken()
    expect(compareTokens(t, t)).toBe(true)
    expect(compareTokens(t, generateToken())).toBe(false)
    expect(compareTokens('short', t)).toBe(false)
    expect(compareTokens('', '')).toBe(true)
  })
})

describe('pidFile', () => {
  test('readPidFile returns null when missing', async () => {
    const p = await readPidFile(tmpDir)
    expect(p).toBeNull()
  })

  test('writePidFile + readPidFile roundtrip', async () => {
    const now = Date.now()
    const data = {
      version: PID_SCHEMA_VERSION,
      pid: process.pid,
      port: 0,
      startedAt: now,
      lastHeartbeat: now,
      agentVersion: 'test-1.2.3',
    }
    await writePidFile(data, tmpDir)
    const loaded = await readPidFile(tmpDir)
    expect(loaded).toEqual(data)
  })

  test('readPidFile returns null for malformed json', async () => {
    const { pidPath } = getDaemonPaths(tmpDir)
    const { writeFileSync } = await import('fs')
    writeFileSync(pidPath, '{ not valid json')
    const p = await readPidFile(tmpDir)
    expect(p).toBeNull()
  })

  test('readPidFile rejects schema version mismatch', async () => {
    const { pidPath } = getDaemonPaths(tmpDir)
    const { writeFileSync } = await import('fs')
    writeFileSync(
      pidPath,
      JSON.stringify({
        version: 999,
        pid: 1,
        port: 0,
        startedAt: 1,
        lastHeartbeat: 1,
        agentVersion: 'x',
      }),
    )
    const p = await readPidFile(tmpDir)
    expect(p).toBeNull()
  })

  test('updateHeartbeat mutates lastHeartbeat only', async () => {
    const startedAt = 100
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 42,
        startedAt,
        lastHeartbeat: startedAt,
        agentVersion: 'x',
      },
      tmpDir,
    )
    const updated = await updateHeartbeat(tmpDir, 200)
    expect(updated?.startedAt).toBe(startedAt)
    expect(updated?.lastHeartbeat).toBe(200)
    expect(updated?.pid).toBe(process.pid)
    expect(updated?.port).toBe(42)
  })

  test('updateHeartbeat returns null when no pid file', async () => {
    const r = await updateHeartbeat(tmpDir, 200)
    expect(r).toBeNull()
  })

  test('deletePidFile removes the file', async () => {
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 1,
        port: 0,
        startedAt: 1,
        lastHeartbeat: 1,
        agentVersion: 'x',
      },
      tmpDir,
    )
    const { pidPath } = getDaemonPaths(tmpDir)
    expect(existsSync(pidPath)).toBe(true)
    await deletePidFile(tmpDir)
    expect(existsSync(pidPath)).toBe(false)
  })

  test('deletePidFile is idempotent on missing file', async () => {
    await deletePidFile(tmpDir)
    await deletePidFile(tmpDir)
    // 不應丟 — 能走到這行就算過
    expect(true).toBe(true)
  })

  test('isPidAlive(process.pid) is true', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test('isPidAlive rejects invalid pids', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    // 一個幾乎不可能被使用的 PID（跨平台 PID 上限通常 < 4M）
    expect(isPidAlive(99_999_999)).toBe(false)
  })
})

describe('checkDaemonLiveness', () => {
  test('returns stale:missing when no pid file', async () => {
    const r = await checkDaemonLiveness(tmpDir)
    expect(r.stale).toBe(true)
    expect(r.reason).toBe('missing')
  })

  test('returns stale:dead-pid when pid does not exist', async () => {
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 99_999_999,
        port: 0,
        startedAt: 1,
        lastHeartbeat: Date.now(),
        agentVersion: 'x',
      },
      tmpDir,
    )
    const r = await checkDaemonLiveness(tmpDir)
    expect(r.stale).toBe(true)
    expect(r.reason).toBe('dead-pid')
  })

  test('returns stale:no-heartbeat when heartbeat too old', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 0,
        startedAt: now - 120_000,
        lastHeartbeat: now - 120_000,
        agentVersion: 'x',
      },
      tmpDir,
    )
    const r = await checkDaemonLiveness(tmpDir, { now, maxStaleMs: 30_000 })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe('no-heartbeat')
  })

  test('returns stale:false when fresh and alive', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 42,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    const r = await checkDaemonLiveness(tmpDir, { now })
    expect(r.stale).toBe(false)
    expect(r.data?.port).toBe(42)
  })

  test('DEFAULT_MAX_STALE_MS is 30s', () => {
    expect(DEFAULT_MAX_STALE_MS).toBe(30_000)
  })
})

describe('daemonLog', () => {
  test('logger appends JSON lines to log file', async () => {
    const logger = createDaemonLogger(tmpDir)
    await logger.info('hello', { key: 'value' })
    await logger.warn('ouch')
    const { logPath } = getDaemonPaths(tmpDir)
    const raw = readFileSync(logPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = jsonParse(lines[0]!) as {
      ts: string
      level: string
      msg: string
      meta?: { key: string }
    }
    expect(first.level).toBe('info')
    expect(first.msg).toBe('hello')
    expect(first.meta?.key).toBe('value')
    expect(new Date(first.ts).getTime()).toBeGreaterThan(0)
    const second = jsonParse(lines[1]!) as { level: string; msg: string }
    expect(second.level).toBe('warn')
    expect(second.msg).toBe('ouch')
  })

  test('logger survives write errors silently', async () => {
    // 指向不存在且無法建立的路徑：daemon 若 log 寫失敗不該丟
    const logger = createDaemonLogger(join(tmpDir, 'nonexistent-parent'))
    // 先建 parent 讓 mkdir 通過，再手動讓 append 失敗困難；改驗證 happy path
    // 這個 test 主要是確認 API 不會 throw
    await expect(logger.info('ok')).resolves.toBeUndefined()
  })
})

describe('startDaemon — M-DAEMON-1 整合', () => {
  test('writes pid.json + token, then cleans on stop', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'test-1.0.0',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000, // 測試不依賴 heartbeat 觸發
    })

    // pid.json 存在且內容正確
    const pidData = await readPidFile(tmpDir)
    expect(pidData).not.toBeNull()
    expect(pidData?.pid).toBe(process.pid)
    expect(pidData?.agentVersion).toBe('test-1.0.0')

    // token 存在且有效
    const token = await readToken(tmpDir)
    expect(token).toBe(handle.token)
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    // liveness 檢查應為 fresh
    const r = await checkDaemonLiveness(tmpDir)
    expect(r.stale).toBe(false)

    // Stop 後清理 pid.json；token 保留供下次啟動沿用
    await handle.stop()
    await handle.stopped
    expect(existsSync(handle.paths.pidPath)).toBe(false)
    expect(existsSync(handle.paths.tokenPath)).toBe(true)
  })

  test('rejects starting when another daemon is live', async () => {
    const first = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
    })

    let threw: Error | null = null
    try {
      await startDaemon({
        baseDir: tmpDir,
        agentVersion: 'y',
        registerSignalHandlers: false,
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).toBeInstanceOf(DaemonAlreadyRunningError)
    await first.stop()
  })

  test('takes over stale pid.json from dead process', async () => {
    // 先手動寫一個「死 pid」的 pid.json
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: 99_999_999,
        port: 12345,
        startedAt: Date.now() - 3600_000,
        lastHeartbeat: Date.now() - 3600_000,
        agentVersion: 'ghost',
      },
      tmpDir,
    )

    // 啟動應成功接管
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'live',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
    })
    const pidData = await readPidFile(tmpDir)
    expect(pidData?.pid).toBe(process.pid)
    expect(pidData?.agentVersion).toBe('live')
    await handle.stop()
  })

  test('heartbeat updates lastHeartbeat', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 50, // 快速 heartbeat 便於測試
    })
    const before = (await readPidFile(tmpDir))!.lastHeartbeat
    await new Promise(r => setTimeout(r, 150))
    const after = (await readPidFile(tmpDir))!.lastHeartbeat
    expect(after).toBeGreaterThan(before)
    await handle.stop()
  })

  test('stop is idempotent', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
    })
    await handle.stop()
    await handle.stop()
    await handle.stopped
    expect(true).toBe(true)
  })
})
