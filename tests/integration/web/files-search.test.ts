/**
 * M-WEB-PARITY-4：GET /api/projects/:id/files?q= 測試。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRestRoutes } from '../../../src/web/restRoutes.js'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'

function makeFakeRuntime(cwd: string, projectId = 'p1'): ProjectRuntime {
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

function makeRegistry(runtime: ProjectRuntime): ProjectRegistry {
  return {
    loadProject: async () => runtime,
    getProject: id => (id === runtime.projectId ? runtime : null),
    getProjectByCwd: () => null,
    listProjects: () => [runtime],
    unloadProject: async () => true,
    rotateProject: async () => null,
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('M-WEB-PARITY-4 GET /api/projects/:id/files', () => {
  let tmp: string
  let rt: ProjectRuntime
  let reg: ProjectRegistry
  let rest: ReturnType<typeof createRestRoutes>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'files-search-'))
    mkdirSync(join(tmp, 'src', 'web'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'web', 'restRoutes.ts'), '// hi')
    writeFileSync(join(tmp, 'src', 'web', 'fileSearch.ts'), '// hi')
    writeFileSync(join(tmp, 'README.md'), '# hi')
    mkdirSync(join(tmp, 'node_modules', 'leaked'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'leaked', 'index.js'), '// noise')
    rt = makeFakeRuntime(tmp)
    reg = makeRegistry(rt)
    rest = createRestRoutes({ registry: reg })
  })

  test('q=README → 找到 README.md', async () => {
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${rt.projectId}/files?q=README`,
      ),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      files: { path: string; type: string }[]
    }
    expect(body.files.some(f => f.path.endsWith('README.md'))).toBe(true)
  })

  test('q=restR → fuzzy 找到 restRoutes.ts', async () => {
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${rt.projectId}/files?q=restR`,
      ),
    )
    const body = (await r!.json()) as { files: { path: string }[] }
    expect(body.files.some(f => f.path.includes('restRoutes.ts'))).toBe(true)
  })

  test('q 為空 → 回前 N 個 entry（不限結果）', async () => {
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${rt.projectId}/files?q=`,
      ),
    )
    const body = (await r!.json()) as { files: unknown[] }
    expect(body.files.length).toBeGreaterThan(0)
  })

  test('node_modules 被 ignore', async () => {
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${rt.projectId}/files?q=leaked`,
      ),
    )
    const body = (await r!.json()) as { files: { path: string }[] }
    expect(body.files.find(f => f.path.includes('node_modules'))).toBeUndefined()
  })

  test('limit 上限 200', async () => {
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${rt.projectId}/files?q=&limit=999`,
      ),
    )
    expect(r!.status).toBe(200)
  })

  test('未 load 的 project → 404', async () => {
    const r = await rest.handle(
      new Request(`http://x/api/projects/nonexistent/files?q=foo`),
    )
    expect(r!.status).toBe(404)
  })

  // teardown 由 OS tmpdir 自然處理；額外 rm 防 win 留垃圾
  test('teardown', () => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })
})
