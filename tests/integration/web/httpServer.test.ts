/**
 * M-WEB-3：httpServer integration 測試。
 *   - 起一個真實 Bun.serve 在 OS 指派 port（透過 base port + probe），fetch 驗證
 *   - port probing：占用第一 port → 自動往上找
 *   - /api/health 永遠可用
 *   - 靜態檔 + SPA fallback
 *   - dev proxy 模式（mock fetch）
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHttpServer, type HttpServerHandle } from '../../../src/web/httpServer.js'

let tmpDir: string
let started: HttpServerHandle[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-http-'))
})

afterEach(async () => {
  for (const h of started) {
    try {
      await h.stop()
    } catch {
      // ignore
    }
  }
  started = []
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

async function startOne(opts: {
  port: number
  webRootPath?: string
  devProxyUrl?: string
  fetchHandler?: Parameters<typeof startHttpServer>[0]['fetchHandler']
}): Promise<HttpServerHandle> {
  const h = await startHttpServer({
    host: '127.0.0.1',
    port: opts.port,
    webRootPath: opts.webRootPath ?? tmpDir,
    devProxyUrl: opts.devProxyUrl,
    fetchHandler: opts.fetchHandler,
    log: () => {},
  })
  started.push(h)
  return h
}

function pickBasePort(): number {
  // 走相對高的範圍降低衝突；測試自身 port probing 容忍最多 +10
  return 19000 + Math.floor(Math.random() * 1000)
}

describe('startHttpServer', () => {
  test('binds + serves /api/health', async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html>x</html>')
    const h = await startOne({ port: pickBasePort() })
    expect(h.host).toBe('127.0.0.1')
    expect(h.port).toBeGreaterThan(0)
    const r = await fetch(`http://127.0.0.1:${h.port}/api/health`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; serverTime: number }
    expect(body.ok).toBe(true)
    expect(typeof body.serverTime).toBe('number')
  })

  test('serves index.html on /', async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html>spa</html>')
    const h = await startOne({ port: pickBasePort() })
    const r = await fetch(`http://127.0.0.1:${h.port}/`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<html>spa</html>')
  })

  test('serves static asset with cache header', async () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    mkdirSync(join(tmpDir, 'assets'))
    writeFileSync(join(tmpDir, 'assets', 'app.js'), 'console.log("hi")')
    const h = await startOne({ port: pickBasePort() })
    const r = await fetch(`http://127.0.0.1:${h.port}/assets/app.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toContain('immutable')
    expect(await r.text()).toBe('console.log("hi")')
  })

  test('SPA fallback for unknown path', async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html>spa</html>')
    const h = await startOne({ port: pickBasePort() })
    const r = await fetch(`http://127.0.0.1:${h.port}/some/deep/route`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<html>spa</html>')
  })

  test('build-missing 503 hint when index.html absent', async () => {
    const h = await startOne({ port: pickBasePort() })
    const r = await fetch(`http://127.0.0.1:${h.port}/`)
    expect(r.status).toBe(503)
    expect(await r.text()).toContain('bun run build:web')
  })

  test('/api/* returns 404 JSON when no fetchHandler', async () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    const h = await startOne({ port: pickBasePort() })
    const r = await fetch(`http://127.0.0.1:${h.port}/api/projects`)
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('json')
  })

  test('caller fetchHandler intercepts /api/foo', async () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    const h = await startOne({
      port: pickBasePort(),
      fetchHandler: async (req) => {
        const u = new URL(req.url)
        if (u.pathname === '/api/foo') {
          return new Response('bar', { status: 200 })
        }
        return null
      },
    })
    const r = await fetch(`http://127.0.0.1:${h.port}/api/foo`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('bar')
  })

  test('port probing: occupied first → +1', async () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    const base = pickBasePort()
    const h1 = await startOne({ port: base })
    expect(h1.port).toBe(base)
    const h2 = await startOne({ port: base })
    expect(h2.port).toBe(base + 1)
  })

  test('listAccessibleUrls returns at least one URL', async () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    const h = await startOne({ port: pickBasePort() })
    const urls = h.listAccessibleUrls()
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toMatch(/^http:\/\//)
  })
})

describe('dev proxy mode', () => {
  test('proxies / to upstream when devProxyUrl set', async () => {
    // 起一個 upstream Bun.serve 模擬 vite dev server
    const upstreamPort = pickBasePort() + 500
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: upstreamPort,
      fetch: () =>
        new Response('vite dev', {
          headers: { 'content-type': 'text/html' },
        }),
    })
    try {
      const h = await startOne({
        port: pickBasePort(),
        devProxyUrl: `http://127.0.0.1:${upstreamPort}`,
      })
      expect(h.inDevProxyMode).toBe(true)
      const r = await fetch(`http://127.0.0.1:${h.port}/`)
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('vite dev')
    } finally {
      upstream.stop(true)
    }
  })

  test('502 when dev proxy unreachable', async () => {
    const h = await startOne({
      port: pickBasePort(),
      devProxyUrl: 'http://127.0.0.1:1', // 幾乎一定 refuse
    })
    const r = await fetch(`http://127.0.0.1:${h.port}/`)
    expect(r.status).toBe(502)
    expect(await r.text()).toContain('Dev proxy unreachable')
  })
})
