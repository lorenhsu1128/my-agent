/**
 * M-WEB-CLOSEOUT-10：/api/discord/* REST 端點。
 *
 * 用 fake DiscordController 不接觸真 discord.js client。涵蓋：
 *   - GET status / bindings
 *   - POST bind / unbind
 *   - POST reload / restart
 *   - 沒注入 controller 時 503
 *   - 廣播 discord.statusChanged
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { createRestRoutes } from '../../../src/web/restRoutes.js'
import type { DiscordController } from '../../../src/discord/discordController.js'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'

// MACRO shim
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).MACRO === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).MACRO = {
    VERSION: 'test',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'test-snapshot',
    FEEDBACK_CHANNEL: 'github',
  }
}

function fakeRuntime(projectId: string, cwd: string): ProjectRuntime {
  const replIds = new Set<string>()
  return {
    projectId,
    cwd,
    context: {} as never,
    sessionHandle: { sessionId: 'sess-' + projectId } as never,
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

function fakeRegistry(): ProjectRegistry {
  const map = new Map<string, ProjectRuntime>()
  return {
    loadProject: async () => fakeRuntime('p', '/p'),
    getProject: id => map.get(id) ?? null,
    getProjectByCwd: () => null,
    listProjects: () => [...map.values()],
    unloadProject: async () => false,
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

function makeFakeController(): {
  ctl: DiscordController
  calls: string[]
} {
  const calls: string[] = []
  const ctl: DiscordController = {
    getStatus: () => ({
      enabled: true,
      running: true,
      guildId: 'g1',
      whitelistUserCount: 2,
      projectCount: 1,
      bindingCount: 1,
      botTag: 'bot#0001',
    }),
    listBindings: () => [{ channelId: 'c1', cwd: '/p1' }],
    bind: async (cwd, name) => {
      calls.push(`bind:${cwd}:${name ?? ''}`)
      return { ok: true, channelId: 'c-new', channelName: 'foo', url: 'https://x' }
    },
    unbind: async cwd => {
      calls.push(`unbind:${cwd}`)
      return { ok: true }
    },
    reload: async () => {
      calls.push('reload')
      return { ok: true }
    },
    restart: async () => {
      calls.push('restart')
      return { ok: true }
    },
  }
  return { ctl, calls }
}

describe('M-WEB-CLOSEOUT-10：/api/discord/*', () => {
  let broadcasted: unknown[]

  beforeEach(() => {
    broadcasted = []
  })

  test('沒注入 controller → 503', async () => {
    const rest = createRestRoutes({ registry: fakeRegistry() })
    const r = await rest.handle(
      new Request('http://x/api/discord/status'),
    )
    expect(r!.status).toBe(503)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('DISCORD_NOT_AVAILABLE')
  })

  test('GET /api/discord/status → 200 with status', async () => {
    const { ctl } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
    })
    const r = await rest.handle(new Request('http://x/api/discord/status'))
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      enabled: boolean
      running: boolean
      botTag?: string
    }
    expect(body.enabled).toBe(true)
    expect(body.running).toBe(true)
    expect(body.botTag).toBe('bot#0001')
  })

  test('GET /api/discord/bindings → list', async () => {
    const { ctl } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
    })
    const r = await rest.handle(new Request('http://x/api/discord/bindings'))
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      bindings: Array<{ channelId: string; cwd: string }>
    }
    expect(body.bindings).toEqual([{ channelId: 'c1', cwd: '/p1' }])
  })

  test('POST /api/discord/bind → ok + 廣播', async () => {
    const { ctl, calls } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
      broadcastAll: f => broadcasted.push(f),
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/myproj', projectName: 'my' }),
      }),
    )
    expect(r!.status).toBe(200)
    expect(calls).toEqual(['bind:/myproj:my'])
    expect(broadcasted).toHaveLength(1)
    expect((broadcasted[0] as { type: string }).type).toBe(
      'discord.statusChanged',
    )
  })

  test('POST /api/discord/bind 缺 cwd → 400', async () => {
    const { ctl } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(r!.status).toBe(400)
  })

  test('POST /api/discord/unbind → ok + 廣播', async () => {
    const { ctl, calls } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
      broadcastAll: f => broadcasted.push(f),
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/unbind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/myproj' }),
      }),
    )
    expect(r!.status).toBe(200)
    expect(calls).toEqual(['unbind:/myproj'])
    expect(broadcasted).toHaveLength(1)
  })

  test('POST /api/discord/reload → ok', async () => {
    const { ctl, calls } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
      broadcastAll: f => broadcasted.push(f),
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/reload', { method: 'POST' }),
    )
    expect(r!.status).toBe(200)
    expect(calls).toEqual(['reload'])
  })

  test('POST /api/discord/restart → ok', async () => {
    const { ctl, calls } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
      broadcastAll: f => broadcasted.push(f),
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/restart', { method: 'POST' }),
    )
    expect(r!.status).toBe(200)
    expect(calls).toEqual(['restart'])
  })

  test('POST /api/discord/bind controller 失敗 → 400', async () => {
    const ctl: DiscordController = {
      getStatus: () => ({
        enabled: true,
        running: false,
        whitelistUserCount: 0,
        projectCount: 0,
        bindingCount: 0,
      }),
      listBindings: () => [],
      bind: async () => ({ ok: false, error: 'guildId not set' }),
      unbind: async () => ({ ok: true }),
      reload: async () => ({ ok: true }),
      restart: async () => ({ ok: true }),
    }
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/x' }),
      }),
    )
    expect(r!.status).toBe(400)
    const body = (await r!.json()) as { code: string; error: string }
    expect(body.code).toBe('DISCORD_BIND_FAILED')
    expect(body.error).toBe('guildId not set')
  })

  test('未知 /api/discord/* 路徑 → 404', async () => {
    const { ctl } = makeFakeController()
    const rest = createRestRoutes({
      registry: fakeRegistry(),
      getDiscordController: () => ctl,
    })
    const r = await rest.handle(
      new Request('http://x/api/discord/unknown'),
    )
    expect(r!.status).toBe(404)
  })
})
