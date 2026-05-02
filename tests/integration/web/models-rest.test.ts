/**
 * M-WEB-PARITY-7：GET /api/models + PUT /api/models/current。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { createRestRoutes } from '../../../src/web/restRoutes.js'
import type { ProjectRegistry } from '../../../src/daemon/projectRegistry.js'

function emptyRegistry(): ProjectRegistry {
  return {
    loadProject: async () => {
      throw new Error('not used')
    },
    getProject: () => null,
    getProjectByCwd: () => null,
    listProjects: () => [],
    unloadProject: async () => false,
    rotateProject: async () => null,
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('M-WEB-PARITY-7 GET /api/models', () => {
  let rest: ReturnType<typeof createRestRoutes>
  beforeEach(() => {
    rest = createRestRoutes({ registry: emptyRegistry() })
  })

  test('GET /api/models → 200，回 models[] + current', async () => {
    const r = await rest.handle(new Request('http://x/api/models'))
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      models: { value: string }[]
      current: string | null
    }
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
    // current 可能 null（fresh state），但不能 undefined
    expect(body.current === null || typeof body.current === 'string').toBe(true)
  })

  test('PUT /api/models/current → 切已知 model 成功 + broadcast', async () => {
    const broadcasts: unknown[] = []
    const r = createRestRoutes({
      registry: emptyRegistry(),
      broadcastAll: p => broadcasts.push(p),
    })
    // 先拿一個已知 model
    const list = await r.handle(new Request('http://x/api/models'))
    const body = (await list!.json()) as { models: { value: string }[] }
    // 找一個 well-formed model value（過濾掉 sentinel / 空值）
    const target = body.models.find(
      m => typeof m.value === 'string' && m.value.length > 0,
    )?.value
    if (!target) throw new Error('no usable model in list: ' + JSON.stringify(body.models))
    const put = await r.handle(
      new Request('http://x/api/models/current', {
        method: 'PUT',
        body: JSON.stringify({ model: target }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    if (put!.status !== 200) {
      const errBody = await put!.text()
      console.error('PUT failed:', target, errBody)
    }
    expect(put!.status).toBe(200)
    const putBody = (await put!.json()) as { ok: boolean; model: string }
    expect(putBody.ok).toBe(true)
    expect(putBody.model).toBe(target)
    expect(
      broadcasts.some(b => (b as { type?: string }).type === 'model.changed'),
    ).toBe(true)
  })

  test('PUT /api/models/current → 未知 model 回 400', async () => {
    const put = await rest.handle(
      new Request('http://x/api/models/current', {
        method: 'PUT',
        body: JSON.stringify({ model: 'totally-fake-model-name' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(put!.status).toBe(400)
  })

  test('PUT /api/models/current → 缺 body.model 回 400', async () => {
    const put = await rest.handle(
      new Request('http://x/api/models/current', {
        method: 'PUT',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(put!.status).toBe(400)
  })
})
