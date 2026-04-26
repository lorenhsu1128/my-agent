/**
 * M-WEB-3：staticServer 純函式 + path traversal 防護測試。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getContentType,
  handleStaticRequest,
  resolveDefaultWebRoot,
  resolveStaticPath,
  serveSpaFallback,
} from '../../../src/web/staticServer.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-static-'))
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('getContentType', () => {
  test('html', () => expect(getContentType('a.html')).toContain('text/html'))
  test('js', () => expect(getContentType('a.js')).toContain('javascript'))
  test('css', () => expect(getContentType('a.css')).toContain('text/css'))
  test('svg', () => expect(getContentType('a.svg')).toContain('image/svg'))
  test('png', () => expect(getContentType('a.png')).toBe('image/png'))
  test('woff2', () => expect(getContentType('a.woff2')).toBe('font/woff2'))
  test('unknown → octet-stream', () =>
    expect(getContentType('a.xyz')).toBe('application/octet-stream'))
})

describe('resolveStaticPath', () => {
  test('serves index.html for /', () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html></html>')
    expect(resolveStaticPath(tmpDir, '/')).toBe(join(tmpDir, 'index.html'))
    expect(resolveStaticPath(tmpDir, '')).toBe(join(tmpDir, 'index.html'))
  })

  test('returns null for missing file', () => {
    expect(resolveStaticPath(tmpDir, '/missing.js')).toBeNull()
  })

  test('rejects path traversal ../', () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    // 上層建一檔，確認 .. 跳出後也找不到
    expect(resolveStaticPath(tmpDir, '/../etc/passwd')).toBeNull()
    expect(resolveStaticPath(tmpDir, '/..%2fpasswd')).toBeNull()
  })

  test('rejects directory listing', () => {
    mkdirSync(join(tmpDir, 'sub'))
    expect(resolveStaticPath(tmpDir, '/sub')).toBeNull()
  })

  test('serves nested file', () => {
    mkdirSync(join(tmpDir, 'assets'))
    writeFileSync(join(tmpDir, 'assets', 'app.js'), 'x')
    expect(resolveStaticPath(tmpDir, '/assets/app.js')).toBe(
      join(tmpDir, 'assets', 'app.js'),
    )
  })

  test('strips query / hash', () => {
    writeFileSync(join(tmpDir, 'index.html'), 'x')
    expect(resolveStaticPath(tmpDir, '/index.html?v=1')).toBe(
      join(tmpDir, 'index.html'),
    )
    expect(resolveStaticPath(tmpDir, '/index.html#frag')).toBe(
      join(tmpDir, 'index.html'),
    )
  })
})

describe('handleStaticRequest', () => {
  test('serves existing file with correct content-type', async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html>hi</html>')
    const req = new Request('http://x/index.html')
    const r = await handleStaticRequest(req, tmpDir)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(200)
    expect(r!.headers.get('content-type')).toContain('text/html')
    expect(await r!.text()).toBe('<html>hi</html>')
  })

  test('returns null for missing path (caller fallbacks)', async () => {
    const req = new Request('http://x/missing.js')
    const r = await handleStaticRequest(req, tmpDir)
    expect(r).toBeNull()
  })

  test('rejects POST', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'x')
    const req = new Request('http://x/a.txt', { method: 'POST' })
    const r = await handleStaticRequest(req, tmpDir)
    expect(r).toBeNull()
  })

  test('HEAD returns headers without body', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'hello')
    const req = new Request('http://x/a.txt', { method: 'HEAD' })
    const r = await handleStaticRequest(req, tmpDir)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(200)
    expect(r!.headers.get('content-length')).toBe('5')
  })

  test('hashed asset gets immutable cache', async () => {
    mkdirSync(join(tmpDir, 'assets'))
    writeFileSync(join(tmpDir, 'assets', 'app-hash.js'), 'x')
    const req = new Request('http://x/assets/app-hash.js')
    const r = await handleStaticRequest(req, tmpDir)
    expect(r!.headers.get('cache-control')).toContain('immutable')
  })
})

describe('serveSpaFallback', () => {
  test('returns index.html when present', async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html>spa</html>')
    const r = await serveSpaFallback(tmpDir)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<html>spa</html>')
  })

  test('returns 503 with build hint when index.html missing', async () => {
    const r = await serveSpaFallback(tmpDir)
    expect(r.status).toBe(503)
    expect(await r.text()).toContain('bun run build:web')
  })
})

describe('resolveDefaultWebRoot', () => {
  test('returns absolute path ending with web/dist', () => {
    const root = resolveDefaultWebRoot()
    expect(root.length).toBeGreaterThan(0)
    expect(root.replace(/\\/g, '/').endsWith('/web/dist')).toBe(true)
  })
})
