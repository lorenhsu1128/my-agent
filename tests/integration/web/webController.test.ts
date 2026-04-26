/**
 * M-WEB-7：webController 單元測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWebServerController } from '../../../src/web/webController.js'
import { startHttpServer } from '../../../src/web/httpServer.js'
import { DEFAULT_WEB_CONFIG } from '../../../src/webConfig/index.js'
import type { ProjectRegistry } from '../../../src/daemon/projectRegistry.js'
import { handleWebControl, isWebControlRequest } from '../../../src/daemon/webRpc.ts'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-ctl-'))
  writeFileSync(join(tmpDir, 'index.html'), '<html>x</html>')
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function fakeRegistry(): ProjectRegistry {
  return {
    loadProject: async () => {
      throw new Error('not used')
    },
    getProject: () => null,
    getProjectByCwd: () => null,
    listProjects: () => [],
    unloadProject: async () => false,
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

function pickPort() {
  return 22000 + Math.floor(Math.random() * 1000)
}

describe('webController', () => {
  test('start → status running → stop → status not running', async () => {
    const cfg = {
      ...DEFAULT_WEB_CONFIG,
      enabled: true,
      port: pickPort(),
      bindHost: '127.0.0.1',
    }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      // 用 webRoot 指向我們建的 tmp（不然 SPA fallback 會回 503，但 health 還是 200）
      startHttpServerImpl: opts =>
        startHttpServer({ ...opts, webRootPath: tmpDir }),
      log: () => {},
    })
    expect(ctl.isRunning()).toBe(false)
    const s1 = await ctl.start()
    expect(s1.running).toBe(true)
    expect(typeof s1.port).toBe('number')
    expect(s1.urls?.length).toBeGreaterThan(0)
    // 真的能打通
    const r = await fetch(`http://127.0.0.1:${s1.port}/api/health`)
    expect(r.status).toBe(200)
    expect(ctl.isRunning()).toBe(true)
    const s2 = await ctl.stop()
    expect(s2.running).toBe(false)
    expect(ctl.isRunning()).toBe(false)
  })

  test('start while running → no-op', async () => {
    const cfg = {
      ...DEFAULT_WEB_CONFIG,
      port: pickPort(),
      bindHost: '127.0.0.1',
    }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: opts =>
        startHttpServer({ ...opts, webRootPath: tmpDir }),
      log: () => {},
    })
    const s1 = await ctl.start()
    const s2 = await ctl.start()
    expect(s1.port).toBe(s2.port)
    await ctl.stop()
  })

  test('stop while not running → no-op', async () => {
    const cfg = { ...DEFAULT_WEB_CONFIG, port: pickPort() }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: opts =>
        startHttpServer({ ...opts, webRootPath: tmpDir }),
      log: () => {},
    })
    const s = await ctl.stop()
    expect(s.running).toBe(false)
  })

  test('start failure cleanly resets state', async () => {
    const cfg = { ...DEFAULT_WEB_CONFIG, port: 0, maxPortProbes: 1 }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: () => {
        throw new Error('fake start error')
      },
      log: () => {},
    })
    await expect(ctl.start()).rejects.toThrow('fake start error')
    expect(ctl.isRunning()).toBe(false)
    expect(ctl.status().lastError).toContain('fake start error')
  })

  test('reloadConfig wins over closure config', async () => {
    let portUsed: number | undefined
    const initial = { ...DEFAULT_WEB_CONFIG, port: 99999 } // would fail
    const updated = { ...DEFAULT_WEB_CONFIG, port: pickPort(), bindHost: '127.0.0.1' }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: initial,
      reloadConfig: () => updated,
      startHttpServerImpl: opts => {
        portUsed = opts.port
        return startHttpServer({ ...opts, webRootPath: tmpDir })
      },
      log: () => {},
    })
    await ctl.start()
    expect(portUsed).toBe(updated.port)
    await ctl.stop()
  })
})

describe('webRpc', () => {
  test('isWebControlRequest validates shape', () => {
    expect(isWebControlRequest({ type: 'web.control', requestId: 'r', op: 'start' })).toBe(true)
    expect(isWebControlRequest({ type: 'web.control', requestId: 'r', op: 'stop' })).toBe(true)
    expect(isWebControlRequest({ type: 'web.control', requestId: 'r', op: 'status' })).toBe(true)
    expect(isWebControlRequest({ type: 'web.control', requestId: 'r', op: 'unknown' })).toBe(false)
    expect(isWebControlRequest({ type: 'web.control' })).toBe(false)
    expect(isWebControlRequest({})).toBe(false)
  })

  test('handleWebControl status → ok with current snapshot', async () => {
    const cfg = { ...DEFAULT_WEB_CONFIG, port: pickPort() }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: opts => startHttpServer({ ...opts, webRootPath: tmpDir }),
      log: () => {},
    })
    const r = await handleWebControl(ctl, { type: 'web.control', requestId: 'r1', op: 'status' })
    expect(r.ok).toBe(true)
    expect(r.requestId).toBe('r1')
    expect(r.status.running).toBe(false)
  })

  test('handleWebControl start + stop sequence', async () => {
    const cfg = { ...DEFAULT_WEB_CONFIG, port: pickPort(), bindHost: '127.0.0.1' }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: opts => startHttpServer({ ...opts, webRootPath: tmpDir }),
      log: () => {},
    })
    const startR = await handleWebControl(ctl, { type: 'web.control', requestId: '1', op: 'start' })
    expect(startR.ok).toBe(true)
    expect(startR.status.running).toBe(true)
    const stopR = await handleWebControl(ctl, { type: 'web.control', requestId: '2', op: 'stop' })
    expect(stopR.ok).toBe(true)
    expect(stopR.status.running).toBe(false)
  })

  test('handleWebControl start failure → ok=false with error', async () => {
    const cfg = { ...DEFAULT_WEB_CONFIG, port: pickPort() }
    const ctl = createWebServerController({
      registry: fakeRegistry(),
      config: cfg,
      startHttpServerImpl: () => {
        throw new Error('boom')
      },
      log: () => {},
    })
    const r = await handleWebControl(ctl, { type: 'web.control', requestId: 'x', op: 'start' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom')
  })
})
