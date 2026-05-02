/**
 * M-WEB-PARITY-5：image upload + resolveImageRefs。
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRestRoutes } from '../../../src/web/restRoutes.js'
import { storeImage, resolveImageRefs } from '../../../src/web/imageStorage.js'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'

// 1×1 紅 PNG（base64）
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

let tmpHome: string
const ORIG_HOME = process.env.MY_AGENT_CONFIG_HOME

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'image-upload-'))
  process.env.MY_AGENT_CONFIG_HOME = tmpHome
})

afterAll(() => {
  if (ORIG_HOME) process.env.MY_AGENT_CONFIG_HOME = ORIG_HOME
  else delete process.env.MY_AGENT_CONFIG_HOME
})

function fakeRuntime(projectId = 'p1'): ProjectRuntime {
  const replIds = new Set<string>()
  return {
    projectId,
    cwd: '/tmp/x',
    context: {} as never,
    sessionHandle: { sessionId: 's' } as never,
    broker: {} as never,
    permissionRouter: {} as never,
    cron: {} as never,
    lastActivityAt: 0,
    attachedReplIds: replIds,
    hasAttachedRepl: () => replIds.size > 0,
    touch: () => {},
    attachRepl: id => replIds.add(id),
    detachRepl: id => replIds.delete(id),
    dispose: async () => {},
  }
}

function makeReg(rt: ProjectRuntime): ProjectRegistry {
  return {
    loadProject: async () => rt,
    getProject: id => (id === rt.projectId ? rt : null),
    getProjectByCwd: () => null,
    listProjects: () => [rt],
    unloadProject: async () => true,
    rotateProject: async () => null,
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('M-WEB-PARITY-5 imageStorage', () => {
  test('storeImage + resolveImageRefs round-trip', () => {
    const rt = fakeRuntime()
    const buf = Buffer.from(RED_PNG_B64, 'base64')
    const stored = storeImage({
      projectId: rt.projectId,
      data: buf,
      mimeType: 'image/png',
    })
    expect(stored.imageId.length).toBeGreaterThan(15)
    expect(stored.refToken).toBe(`[Image:${stored.imageId}]`)
    expect(existsSync(stored.path)).toBe(true)

    const r = resolveImageRefs(`描述 ${stored.refToken} 這張圖`, rt.projectId)
    expect(r.images.length).toBe(1)
    expect(r.images[0]!.type).toBe('image')
    expect(r.images[0]!.source.media_type).toBe('image/png')
    expect(r.text).toBe('描述  這張圖')
    rmSync(tmpHome, { recursive: true, force: true })
  })

  test('storeImage 拒絕未知 mimeType', () => {
    expect(() =>
      storeImage({
        projectId: 'p1',
        data: Buffer.from('hi'),
        mimeType: 'application/pdf',
      }),
    ).toThrow()
  })

  test('storeImage 拒絕超大檔案', () => {
    expect(() =>
      storeImage({
        projectId: 'p1',
        data: Buffer.alloc(11 * 1024 * 1024),
        mimeType: 'image/png',
      }),
    ).toThrow()
  })

  test('resolveImageRefs 找不到 imageId 時保留原 token', () => {
    const r = resolveImageRefs(
      '見 [Image:00000000-0000-0000-0000-000000000000] 圖',
      'p1',
    )
    expect(r.images.length).toBe(0)
    expect(r.text).toContain('[Image:00000000-')
  })
})

describe('M-WEB-PARITY-5 POST /api/projects/:id/images', () => {
  test('上傳成功 → 201 + refToken', async () => {
    const rt = fakeRuntime()
    const rest = createRestRoutes({ registry: makeReg(rt) })
    const r = await rest.handle(
      new Request(`http://x/api/projects/${rt.projectId}/images`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: 'image/png', data: RED_PNG_B64 }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(r!.status).toBe(201)
    const body = (await r!.json()) as {
      imageId: string
      refToken: string
      size: number
    }
    expect(body.refToken).toBe(`[Image:${body.imageId}]`)
    expect(body.size).toBeGreaterThan(0)
  })

  test('未 load 的 project → 404', async () => {
    const rest = createRestRoutes({ registry: makeReg(fakeRuntime('other')) })
    const r = await rest.handle(
      new Request(`http://x/api/projects/missing/images`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: 'image/png', data: RED_PNG_B64 }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(r!.status).toBe(404)
  })

  test('缺 body 欄位 → 400', async () => {
    const rt = fakeRuntime()
    const rest = createRestRoutes({ registry: makeReg(rt) })
    const r = await rest.handle(
      new Request(`http://x/api/projects/${rt.projectId}/images`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(r!.status).toBe(400)
  })

  test('空 base64 data → 400', async () => {
    const rt = fakeRuntime()
    const rest = createRestRoutes({ registry: makeReg(rt) })
    const r = await rest.handle(
      new Request(`http://x/api/projects/${rt.projectId}/images`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: 'image/png', data: '' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(r!.status).toBe(400)
  })
})
