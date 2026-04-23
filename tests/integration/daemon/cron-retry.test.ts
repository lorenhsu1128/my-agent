import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemonCronWiring } from '../../../src/daemon/cronWiring'
import type { SessionBroker } from '../../../src/daemon/sessionBroker'
import type { CronTask } from '../../../src/utils/cronTasks'

// Minimal broker fake that plumbs queue.submit/on/off into an EventEmitter
// so tests can drive turnEnd / runnerEvent with specific inputIds.
function makeBrokerWithEvents(): {
  broker: SessionBroker
  emitter: EventEmitter
  submits: { payload: string; id: string }[]
  nextId: () => string
} {
  const emitter = new EventEmitter()
  const submits: { payload: string; id: string }[] = []
  let counter = 0
  const nextId = () => `inp-${++counter}`
  const queue = {
    submit: (payload: unknown) => {
      const id = nextId()
      submits.push({ payload: String(payload), id })
      return id
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler)
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.off(event, handler)
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broker = {
    queue: queue as any,
    sessionId: 'test',
    dispose: async () => {},
  } satisfies SessionBroker
  return { broker, emitter, submits, nextId }
}

// Minimal scheduler fake: captures onFireTask so tests can invoke it.
function makeFakeSchedulerModules() {
  const captured: {
    onFireTask?: (task: CronTask) => void
    onFire?: (prompt: string) => void
  } = {}
  return {
    modules: {
      createCronScheduler: (opts: {
        onFire?: (p: string) => void
        onFireTask?: (t: CronTask) => void
      }) => {
        captured.onFire = opts.onFire
        captured.onFireTask = opts.onFireTask
        return {
          start: () => {},
          stop: () => {},
          getNextFireTime: () => null,
        }
      },
      getCronJitterConfig: () => ({}) as unknown as never,
      runPreRunScript: async () => ({ ok: true, stdout: '' }),
      augmentPromptWithPreRun: (p: string) => p,
    },
    captured,
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('daemon cron retry path', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-retry-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('task without retry config → single fire, no watcher', async () => {
    const { broker, submits } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    captured.onFireTask!({
      id: 'simple',
      cron: '*/5 * * * *',
      prompt: 'hi',
      createdAt: Date.now(),
      recurring: true,
    })
    await sleep(20)
    expect(submits.length).toBe(1)
    expect(submits[0]!.payload).toBe('hi')
  })

  test('turn-error failureMode → retries on failure, stops on success', async () => {
    const { broker, emitter, submits } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    const task: CronTask = {
      id: 'retry-me',
      cron: '*/5 * * * *',
      prompt: 'try',
      createdAt: Date.now(),
      recurring: true,
      retry: {
        maxAttempts: 3,
        backoffMs: 10,
        failureMode: { kind: 'turn-error' },
        attemptCount: 0,
      },
    }
    // Kick off fire — it should submit once and wait for turnEnd.
    void captured.onFireTask!(task)
    await sleep(20)
    expect(submits.length).toBe(1)
    // Emit turnEnd error for first submit → wiring should schedule retry.
    emitter.emit('turnEnd', {
      input: { id: submits[0]!.id },
      endedAt: Date.now(),
      reason: 'error',
      error: 'boom',
    })
    // Wait for backoff (10ms) + a bit.
    await sleep(50)
    expect(submits.length).toBe(2)
    // Second attempt succeeds → no more fires.
    emitter.emit('turnEnd', {
      input: { id: submits[1]!.id },
      endedAt: Date.now(),
      reason: 'done',
    })
    await sleep(60)
    expect(submits.length).toBe(2)
  })

  test('exhausts after maxAttempts failures', async () => {
    const { broker, emitter, submits } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    const task: CronTask = {
      id: 'never-ok',
      cron: '*/5 * * * *',
      prompt: 'x',
      createdAt: Date.now(),
      recurring: true,
      retry: {
        maxAttempts: 2,
        backoffMs: 5,
        failureMode: { kind: 'turn-error' },
        attemptCount: 0,
      },
    }
    void captured.onFireTask!(task)
    await sleep(15)
    expect(submits.length).toBe(1)
    emitter.emit('turnEnd', {
      input: { id: submits[0]!.id },
      endedAt: Date.now(),
      reason: 'error',
    })
    await sleep(30)
    expect(submits.length).toBe(2)
    emitter.emit('turnEnd', {
      input: { id: submits[1]!.id },
      endedAt: Date.now(),
      reason: 'error',
    })
    await sleep(30)
    // maxAttempts=2 exhausted — no third submit.
    expect(submits.length).toBe(2)
  })

  test('emits cronFireEvent lifecycle: fired → retrying → completed', async () => {
    const { broker, emitter, submits } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    const handle = startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    const seen: Array<{ status: string; attempt?: number }> = []
    handle.events.on(
      'cronFireEvent',
      (e: { status: string; attempt?: number }) => {
        seen.push({ status: e.status, attempt: e.attempt })
      },
    )
    const task: CronTask = {
      id: 'life',
      cron: '*/5 * * * *',
      prompt: 'run',
      createdAt: Date.now(),
      recurring: true,
      retry: {
        maxAttempts: 3,
        backoffMs: 5,
        failureMode: { kind: 'turn-error' },
        attemptCount: 0,
      },
    }
    void captured.onFireTask!(task)
    await sleep(15)
    emitter.emit('turnEnd', {
      input: { id: submits[0]!.id },
      endedAt: Date.now(),
      reason: 'error',
      error: 'boom',
    })
    await sleep(30)
    emitter.emit('turnEnd', {
      input: { id: submits[1]!.id },
      endedAt: Date.now(),
      reason: 'done',
    })
    await sleep(30)
    expect(seen.map(s => s.status)).toEqual([
      'fired',
      'retrying',
      'completed',
    ])
  })

  test('emits cronFireEvent status=skipped when condition blocks', async () => {
    const { broker } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    const handle = startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    const seen: string[] = []
    handle.events.on('cronFireEvent', (e: { status: string }) =>
      seen.push(e.status),
    )
    const task: CronTask = {
      id: 'skip',
      cron: '*/5 * * * *',
      prompt: 'x',
      createdAt: Date.now(),
      recurring: true,
      // lastRunFailed on first fire blocks.
      condition: { kind: 'lastRunFailed' },
    }
    void captured.onFireTask!(task)
    await sleep(20)
    expect(seen).toEqual(['skipped'])
  })

  test('output-regex failureMode: matching output triggers retry', async () => {
    const { broker, emitter, submits } = makeBrokerWithEvents()
    const { modules, captured } = makeFakeSchedulerModules()
    startDaemonCronWiring({
      broker,
      cwd: tmpDir,
      isEnabled: () => true,
      modules: modules as never,
    })
    const task: CronTask = {
      id: 'out-regex',
      cron: '*/5 * * * *',
      prompt: 'go',
      createdAt: Date.now(),
      recurring: true,
      retry: {
        maxAttempts: 2,
        backoffMs: 5,
        failureMode: { kind: 'output-regex', pattern: 'ERR' },
        attemptCount: 0,
      },
    }
    void captured.onFireTask!(task)
    await sleep(15)
    // Simulate runner emitting output containing ERR, then done turn.
    emitter.emit('runnerEvent', {
      input: { id: submits[0]!.id },
      event: { type: 'output', payload: { text: 'something ERR here' } },
    })
    emitter.emit('turnEnd', {
      input: { id: submits[0]!.id },
      endedAt: Date.now(),
      reason: 'done',
    })
    await sleep(30)
    // Output matched ERR → classifier says error → retry.
    expect(submits.length).toBe(2)
  })
})
