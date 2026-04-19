/**
 * M-DAEMON-5：InputQueue 狀態機 + 混合 intent 策略測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createInputQueue,
  defaultIntentForSource,
  type InputQueue,
  type QueueState,
  type RunnerEventWrapper,
  type TurnEndEvent,
  type TurnStartEvent,
} from '../../../src/daemon/inputQueue'
import {
  createDelayedEchoRunner,
  echoRunner,
  type QueuedInput,
  type RunnerEvent,
  type SessionRunner,
} from '../../../src/daemon/sessionRunner'

let q: InputQueue | null = null

beforeEach(() => {
  q = null
})
afterEach(async () => {
  if (q) {
    await q.dispose()
    q = null
  }
})

// 小工具：等某個事件觸發到 N 次
function collect<T>(
  queue: InputQueue,
  event: 'runnerEvent' | 'state' | 'turnStart' | 'turnEnd',
): T[] {
  const bucket: T[] = []
  queue.on(event, (e: T) => bucket.push(e))
  return bucket
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout after ${timeoutMs}ms`))
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('defaultIntentForSource', () => {
  test('repl → interactive', () => {
    expect(defaultIntentForSource('repl')).toBe('interactive')
  })
  test('discord → interactive', () => {
    expect(defaultIntentForSource('discord')).toBe('interactive')
  })
  test('cron → background', () => {
    expect(defaultIntentForSource('cron')).toBe('background')
  })
  test('slash → slash', () => {
    expect(defaultIntentForSource('slash')).toBe('slash')
  })
  test('unknown → background', () => {
    expect(defaultIntentForSource('unknown')).toBe('background')
  })
})

describe('InputQueue — happy path', () => {
  test('IDLE submit runs immediately then goes back to IDLE', async () => {
    q = createInputQueue({ runner: echoRunner })
    const events = collect<RunnerEventWrapper>(q, 'runnerEvent')
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit({ text: 'hi' }, {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    await waitFor(() => ends.length === 1)
    expect(q.state).toBe('IDLE')
    expect(events.length).toBe(2) // output + done
    expect(events[0]!.event.type).toBe('output')
    expect(events[1]!.event.type).toBe('done')
    expect(ends[0]!.reason).toBe('done')
  })

  test('submit returns assigned UUID', () => {
    q = createInputQueue({ runner: echoRunner })
    const id = q.submit('hi', {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  test('state transitions: IDLE → RUNNING → IDLE', async () => {
    q = createInputQueue({ runner: echoRunner })
    const states = collect<QueueState>(q, 'state')
    q.submit('hi', { clientId: 'c1', source: 'repl', intent: 'interactive' })
    await waitFor(() => q!.state === 'IDLE' && states.length >= 2)
    expect(states).toEqual(['RUNNING', 'IDLE'])
  })

  test('emits turnStart and turnEnd with input metadata', async () => {
    q = createInputQueue({ runner: echoRunner })
    const starts = collect<TurnStartEvent>(q, 'turnStart')
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('hi', { clientId: 'c42', source: 'repl', intent: 'interactive' })
    await waitFor(() => ends.length === 1)
    expect(starts[0]!.input.clientId).toBe('c42')
    expect(starts[0]!.input.source).toBe('repl')
    expect(ends[0]!.input.id).toBe(starts[0]!.input.id)
  })
})

describe('InputQueue — background queuing (FIFO)', () => {
  test('background behind running interactive is enqueued and runs after', async () => {
    const runner = createDelayedEchoRunner({ chunks: 2, perChunkDelayMs: 20 })
    q = createInputQueue({ runner })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('first', {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    q.submit('cron-job', {
      clientId: 'c2',
      source: 'cron',
      intent: 'background',
    })
    expect(q.pendingCount).toBe(1)
    await waitFor(() => ends.length === 2, 3_000)
    // FIFO：先 interactive 完再 cron
    expect(ends[0]!.input.source).toBe('repl')
    expect(ends[1]!.input.source).toBe('cron')
    expect(ends[0]!.reason).toBe('done')
    expect(ends[1]!.reason).toBe('done')
  })

  test('multiple backgrounds maintain FIFO order', async () => {
    const runner = createDelayedEchoRunner({ chunks: 1, perChunkDelayMs: 20 })
    q = createInputQueue({ runner })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('a', { clientId: 'a', source: 'repl', intent: 'interactive' })
    q.submit('b', { clientId: 'b', source: 'cron', intent: 'background' })
    q.submit('c', { clientId: 'c', source: 'cron', intent: 'background' })
    q.submit('d', { clientId: 'd', source: 'cron', intent: 'background' })
    await waitFor(() => ends.length === 4, 5_000)
    expect(ends.map(e => e.input.clientId)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('InputQueue — interactive interrupt', () => {
  test('interactive while running aborts current and runs new', async () => {
    const runner = createDelayedEchoRunner({ chunks: 10, perChunkDelayMs: 30 })
    q = createInputQueue({ runner, interruptGraceMs: 500 })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('long', {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    // 讓 runner 真的開始
    await waitFor(() => q!.state === 'RUNNING')
    // 馬上送第二個互動訊息
    q.submit('replace', {
      clientId: 'c2',
      source: 'repl',
      intent: 'interactive',
    })
    await waitFor(() => ends.length === 2, 3_000)
    expect(ends[0]!.reason).toBe('aborted')
    expect(ends[1]!.reason).toBe('done')
    expect(ends[1]!.input.clientId).toBe('c2')
  })

  test('discord interactive also triggers interrupt', async () => {
    const runner = createDelayedEchoRunner({ chunks: 10, perChunkDelayMs: 30 })
    q = createInputQueue({ runner, interruptGraceMs: 500 })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('long', {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    await waitFor(() => q!.state === 'RUNNING')
    q.submit('from-discord', {
      clientId: 'c2',
      source: 'discord',
      intent: 'interactive',
    })
    await waitFor(() => ends.length === 2, 3_000)
    expect(ends[0]!.reason).toBe('aborted')
    expect(ends[1]!.input.source).toBe('discord')
  })

  test('force-clears if runner ignores abort signal', async () => {
    // 故意設計忽略 abort 的 runner
    const deafRunner: SessionRunner = {
      async *run(input) {
        // Never observes signal — 只 sleep 死
        await new Promise(r => setTimeout(r, 2_000))
        yield { type: 'done' } satisfies RunnerEvent
      },
    }
    q = createInputQueue({ runner: deafRunner, interruptGraceMs: 50 })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('stuck', {
      clientId: 'c1',
      source: 'repl',
      intent: 'interactive',
    })
    await waitFor(() => q!.state === 'RUNNING')
    q.submit('new', { clientId: 'c2', source: 'repl', intent: 'interactive' })
    // Grace 到了就 force-clear 第一個為 aborted，跑第二個
    await waitFor(() => ends.length >= 1, 500)
    expect(ends[0]!.reason).toBe('aborted')
    expect(ends[0]!.error).toContain('runner stuck')
  })
})

describe('InputQueue — slash priority', () => {
  test('slash jumps to front of pending queue', async () => {
    const runner = createDelayedEchoRunner({ chunks: 2, perChunkDelayMs: 30 })
    q = createInputQueue({ runner })
    const ends = collect<TurnEndEvent>(q, 'turnEnd')
    q.submit('running', {
      clientId: 'a',
      source: 'repl',
      intent: 'interactive',
    })
    await waitFor(() => q!.state === 'RUNNING')
    // 先 queue 一個 background，再 queue 一個 slash
    q.submit('bg', { clientId: 'b', source: 'cron', intent: 'background' })
    q.submit('slash', { clientId: 's', source: 'slash', intent: 'slash' })
    // pending 應該是 slash 在前、bg 在後
    expect(q.pendingCount).toBe(2)
    await waitFor(() => ends.length === 3, 5_000)
    expect(ends.map(e => e.input.clientId)).toEqual(['a', 's', 'b'])
  })
})

describe('InputQueue — dispose', () => {
  test('dispose clears pending and aborts current', async () => {
    const runner = createDelayedEchoRunner({ chunks: 100, perChunkDelayMs: 20 })
    q = createInputQueue({ runner, interruptGraceMs: 500 })
    q.submit('long', {
      clientId: 'a',
      source: 'repl',
      intent: 'interactive',
    })
    q.submit('q1', { clientId: 'b', source: 'cron', intent: 'background' })
    q.submit('q2', { clientId: 'c', source: 'cron', intent: 'background' })
    await waitFor(() => q!.state === 'RUNNING')
    expect(q.pendingCount).toBe(2)
    await q.dispose()
    expect(q.pendingCount).toBe(0)
    expect(q.state).toBe('IDLE')
  })

  test('submit after dispose throws', async () => {
    q = createInputQueue({ runner: echoRunner })
    await q.dispose()
    expect(() =>
      q!.submit('x', {
        clientId: 'a',
        source: 'repl',
        intent: 'interactive',
      }),
    ).toThrow('disposed')
  })
})

describe('echoRunner / createDelayedEchoRunner', () => {
  test('echoRunner yields output then done', async () => {
    const ctrl = new AbortController()
    const input: QueuedInput = {
      id: 'id-1',
      clientId: 'c',
      source: 'repl',
      intent: 'interactive',
      payload: 'hello',
      enqueuedAt: Date.now(),
    }
    const events: RunnerEvent[] = []
    for await (const e of echoRunner.run(input, ctrl.signal)) {
      events.push(e)
    }
    expect(events.length).toBe(2)
    expect((events[0] as { payload: string }).payload).toBe('hello')
    expect(events[1]!.type).toBe('done')
  })

  test('delayedEchoRunner honors abort mid-stream', async () => {
    const runner = createDelayedEchoRunner({ chunks: 20, perChunkDelayMs: 30 })
    const ctrl = new AbortController()
    const input: QueuedInput = {
      id: 'id-2',
      clientId: 'c',
      source: 'repl',
      intent: 'interactive',
      payload: {},
      enqueuedAt: Date.now(),
    }
    setTimeout(() => ctrl.abort(), 80)
    const events: RunnerEvent[] = []
    for await (const e of runner.run(input, ctrl.signal)) {
      events.push(e)
    }
    const last = events[events.length - 1]!
    expect(last.type).toBe('error')
    expect(events.filter(e => e.type === 'output').length).toBeLessThan(20)
  })
})
