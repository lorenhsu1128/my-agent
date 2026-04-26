/**
 * M-WEB-6：translator 純函式測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  mapTurnSource,
  parseClientFrame,
  permissionPendingToWeb,
  permissionResolvedToWeb,
  projectToWebInfo,
  runnerEventToWeb,
  translateMutationToDaemonFrame,
  turnEndToWeb,
  turnStartToWeb,
} from '../../../src/web/translator.js'
import type { ProjectRuntime } from '../../../src/daemon/projectRegistry.js'

function fakeRuntime(over: Partial<ProjectRuntime> = {}): ProjectRuntime {
  const replIds = new Set<string>(over.attachedReplIds ?? [])
  const r: ProjectRuntime = {
    projectId: over.projectId ?? 'p1',
    cwd: over.cwd ?? 'C:/foo/my-agent',
    context: {} as never,
    sessionHandle: {} as never,
    broker: {} as never,
    permissionRouter: {} as never,
    cron: {} as never,
    lastActivityAt: over.lastActivityAt ?? 1000,
    attachedReplIds: replIds,
    hasAttachedRepl: () => replIds.size > 0,
    touch: () => {},
    attachRepl: id => replIds.add(id),
    detachRepl: id => replIds.delete(id),
    dispose: async () => {},
    ...over,
  }
  return r
}

describe('projectToWebInfo', () => {
  test('basic mapping', () => {
    const r = fakeRuntime({ cwd: '/Users/me/foo' })
    const info = projectToWebInfo(r)
    expect(info.projectId).toBe('p1')
    expect(info.cwd).toBe('/Users/me/foo')
    expect(info.name).toBe('foo')
    expect(info.hasAttachedRepl).toBe(false)
    expect(info.attachedReplCount).toBe(0)
  })
  test('windows path basename', () => {
    const r = fakeRuntime({ cwd: 'C:\\Users\\me\\my-agent' })
    expect(projectToWebInfo(r).name).toBe('my-agent')
  })
  test('attached repl flagged', () => {
    const r = fakeRuntime()
    r.attachRepl('client-1')
    r.attachRepl('client-2')
    const info = projectToWebInfo(r)
    expect(info.hasAttachedRepl).toBe(true)
    expect(info.attachedReplCount).toBe(2)
  })
  test('empty cwd → unknown', () => {
    const r = fakeRuntime({ cwd: '' })
    expect(projectToWebInfo(r).name).toBe('(unknown)')
  })
})

describe('mapTurnSource', () => {
  test('repl / discord / cron / slash', () => {
    expect(mapTurnSource('repl')).toBe('repl')
    expect(mapTurnSource('discord')).toBe('discord')
    expect(mapTurnSource('cron')).toBe('cron')
    expect(mapTurnSource('slash')).toBe('slash')
  })
  test('web and agent passthrough', () => {
    expect(mapTurnSource('web')).toBe('web')
    expect(mapTurnSource('agent')).toBe('agent')
  })
  test('undefined → unknown', () => {
    expect(mapTurnSource(undefined)).toBe('unknown')
    expect(mapTurnSource('weird-source')).toBe('unknown')
  })
})

describe('turn event translators', () => {
  test('turnStart', () => {
    const w = turnStartToWeb('p1', {
      input: {
        id: 'i1',
        source: 'repl',
        clientId: 'c1',
        intent: 'interactive',
        text: 'hi',
        submittedAt: 0,
      } as never,
      startedAt: 12345,
    } as never)
    expect(w).toEqual({
      type: 'turn.start',
      projectId: 'p1',
      inputId: 'i1',
      source: 'repl',
      clientId: 'c1',
      startedAt: 12345,
    })
  })

  test('turnEnd done', () => {
    const w = turnEndToWeb('p1', {
      input: { id: 'i1' } as never,
      reason: 'done',
      endedAt: 99,
    } as never)
    expect(w.type).toBe('turn.end')
    expect(w.reason).toBe('done')
  })

  test('turnEnd error carries error string', () => {
    const w = turnEndToWeb('p1', {
      input: { id: 'i1' } as never,
      reason: 'error',
      error: 'boom',
      endedAt: 99,
    } as never)
    expect(w.error).toBe('boom')
  })

  test('runnerEvent', () => {
    const w = runnerEventToWeb('p1', {
      input: { id: 'i1' } as never,
      event: { type: 'output', text: 'hi' } as never,
    } as never)
    expect(w.type).toBe('turn.event')
    expect(w.event).toEqual({ type: 'output', text: 'hi' })
  })
})

describe('permission translators', () => {
  test('pending', () => {
    const w = permissionPendingToWeb({
      projectId: 'p1',
      toolUseID: 't1',
      toolName: 'Read',
      input: { path: '/x' },
      riskLevel: 'low',
      description: 'read file',
      affectedPaths: ['/x'],
      sourceClientId: 'c1',
    })
    expect(w.type).toBe('permission.pending')
    expect(w.toolName).toBe('Read')
  })

  test('resolved', () => {
    const w = permissionResolvedToWeb({
      projectId: 'p1',
      toolUseID: 't1',
      decision: 'allow',
      by: 'web',
    })
    expect(w).toEqual({
      type: 'permission.resolved',
      projectId: 'p1',
      toolUseID: 't1',
      decision: 'allow',
      by: 'web',
    })
  })
})

describe('parseClientFrame', () => {
  test('rejects non-object', () => {
    expect(parseClientFrame(null)).toEqual({
      ok: false,
      reason: 'frame must be an object',
    })
    expect(parseClientFrame('string')).toEqual({
      ok: false,
      reason: 'frame must be an object',
    })
  })
  test('rejects missing type', () => {
    expect(parseClientFrame({})).toEqual({
      ok: false,
      reason: 'frame.type must be string',
    })
  })
  test('rejects unknown type', () => {
    const r = parseClientFrame({ type: 'whatever' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.rawType).toBe('whatever')
  })

  test('subscribe', () => {
    const r = parseClientFrame({ type: 'subscribe', projectIds: ['a', 'b'] })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.frame).toEqual({ type: 'subscribe', projectIds: ['a', 'b'] })
  })

  test('subscribe filters non-string ids', () => {
    const r = parseClientFrame({ type: 'subscribe', projectIds: ['a', 1, null] })
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'subscribe')
      expect(r.frame.projectIds).toEqual(['a'])
  })

  test('ping', () => {
    expect(parseClientFrame({ type: 'ping' }).ok).toBe(true)
  })

  test('input.submit minimal', () => {
    const r = parseClientFrame({
      type: 'input.submit',
      projectId: 'p1',
      text: 'hi',
    })
    expect(r.ok).toBe(true)
  })

  test('input.submit rejects missing projectId', () => {
    const r = parseClientFrame({ type: 'input.submit', text: 'hi' })
    expect(r.ok).toBe(false)
  })

  test('input.submit rejects bad intent', () => {
    const r = parseClientFrame({
      type: 'input.submit',
      projectId: 'p',
      text: 'x',
      intent: 'weird',
    })
    expect(r.ok).toBe(false)
  })

  test('input.interrupt', () => {
    const r = parseClientFrame({
      type: 'input.interrupt',
      projectId: 'p1',
      inputId: 'i1',
    })
    expect(r.ok).toBe(true)
  })

  test('permission.respond', () => {
    const r = parseClientFrame({
      type: 'permission.respond',
      projectId: 'p1',
      toolUseID: 't1',
      decision: 'allow',
    })
    expect(r.ok).toBe(true)
  })

  test('permission.respond rejects bad decision', () => {
    expect(
      parseClientFrame({
        type: 'permission.respond',
        projectId: 'p1',
        toolUseID: 't1',
        decision: 'maybe',
      }).ok,
    ).toBe(false)
  })

  test('permission.modeSet', () => {
    const r = parseClientFrame({
      type: 'permission.modeSet',
      projectId: 'p',
      mode: 'default',
    })
    expect(r.ok).toBe(true)
  })

  test('mutation', () => {
    const r = parseClientFrame({
      type: 'mutation',
      requestId: 'r1',
      op: 'cron.create',
      payload: { cron: '* * * * *', prompt: 'x' },
    })
    expect(r.ok).toBe(true)
  })

  test('mutation rejects missing requestId', () => {
    expect(
      parseClientFrame({ type: 'mutation', op: 'cron.create' }).ok,
    ).toBe(false)
  })
})

describe('translateMutationToDaemonFrame', () => {
  test('cron.create maps to cron.mutation/create', () => {
    const r = translateMutationToDaemonFrame(
      'cron.create',
      { cron: '* * * * *', prompt: 'hi' },
      'req-1',
    )
    expect('frame' in r).toBe(true)
    if ('frame' in r) {
      expect(r.frame.type).toBe('cron.mutation')
      expect(r.frame.op).toBe('create')
      expect(r.frame.requestId).toBe('req-1')
      expect(r.frame.cron).toBe('* * * * *')
    }
  })

  test('memory.delete maps', () => {
    const r = translateMutationToDaemonFrame('memory.delete', { id: 'x' }, 'r2')
    expect('frame' in r).toBe(true)
  })

  test('llamacpp.setWatchdog maps', () => {
    const r = translateMutationToDaemonFrame(
      'llamacpp.setWatchdog',
      { master: { enabled: true } },
      'r3',
    )
    expect('frame' in r).toBe(true)
    if ('frame' in r) expect(r.frame.type).toBe('llamacpp.configMutation')
  })

  test('unknown op → error', () => {
    const r = translateMutationToDaemonFrame('made.up', {}, 'r')
    expect('error' in r).toBe(true)
  })
})
