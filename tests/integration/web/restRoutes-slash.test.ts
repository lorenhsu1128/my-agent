/**
 * M-WEB-SLASH-A3：GET /api/slash-commands REST + slashCommandStore filter helper 單元測試。
 */
import { describe, expect, test, mock } from 'bun:test'
import type { Command } from '../../../src/types/command'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry'

const fakeCommands: Command[] = [
  {
    name: 'init',
    description: 'init project',
    type: 'prompt',
    progressMessage: '',
    contentLength: 0,
    source: 'builtin',
    getPromptForCommand: async () => [],
  } as Command,
  {
    name: 'cron',
    description: 'cron picker',
    type: 'local-jsx',
    load: async () => ({ call: async () => null }),
  } as Command,
  {
    name: 'help',
    description: 'show help',
    type: 'local',
    aliases: ['h', '?'],
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'text', value: 'h' }) }),
  } as Command,
]

const commandsModule = await import('../../../src/commands.js')
mock.module('../../../src/commands.js', () => ({
  ...commandsModule,
  getCommands: async () => fakeCommands,
}))

const { createRestRoutes } = await import('../../../src/web/restRoutes')

function fakeRuntime(projectId: string, cwd: string): ProjectRuntime {
  const replIds = new Set<string>()
  return {
    projectId,
    cwd,
    context: {} as never,
    sessionHandle: { sessionId: 'sess' } as never,
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
  const projects = new Map<string, ProjectRuntime>()
  return {
    loadProject: async cwd => {
      const id = `pid-${cwd.replace(/[/\\]/g, '_')}`
      if (!projects.has(id)) projects.set(id, fakeRuntime(id, cwd))
      return projects.get(id)!
    },
    getProject: id => projects.get(id) ?? null,
    getProjectByCwd: cwd => {
      for (const p of projects.values()) if (p.cwd === cwd) return p
      return null
    },
    listProjects: () => [...projects.values()],
    unloadProject: async id => projects.delete(id),
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('GET /api/slash-commands', () => {
  test('回 ok 含 commands 陣列', async () => {
    const handler = createRestRoutes({ registry: fakeRegistry() })
    const res = await handler.handle(
      new Request('http://localhost/api/slash-commands'),
    )
    expect(res).toBeDefined()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      commands: Array<{ name: string; webKind: string }>
    }
    expect(body.commands.length).toBe(3)
    const byName = Object.fromEntries(
      body.commands.map(c => [c.name, c.webKind]),
    )
    expect(byName.init).toBe('runnable')
    expect(byName.cron).toBe('web-redirect')
    expect(byName.help).toBe('runnable')
  })

  test('結果按 userFacingName 字典序排序', async () => {
    const handler = createRestRoutes({ registry: fakeRegistry() })
    const res = await handler.handle(
      new Request('http://localhost/api/slash-commands'),
    )
    const body = (await res!.json()) as {
      commands: Array<{ name: string }>
    }
    expect(body.commands.map(c => c.name)).toEqual(['cron', 'help', 'init'])
  })

  test('帶 projectId 但找不到 runtime → fallback default cwd 不報錯', async () => {
    const handler = createRestRoutes({ registry: fakeRegistry() })
    const res = await handler.handle(
      new Request(
        'http://localhost/api/slash-commands?projectId=does-not-exist',
      ),
    )
    expect(res!.status).toBe(200)
  })

  test('CORS headers 正確', async () => {
    const handler = createRestRoutes({ registry: fakeRegistry() })
    const res = await handler.handle(
      new Request('http://localhost/api/slash-commands'),
    )
    expect(res!.headers.get('access-control-allow-origin')).toBe('*')
  })
})
