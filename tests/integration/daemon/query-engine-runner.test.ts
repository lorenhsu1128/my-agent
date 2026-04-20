/**
 * M-DAEMON-4b：QueryEngineRunner 單元測試。
 *
 * 真正的 LLM round-trip 留給 M-DAEMON-4d E2E。這裡只驗證：
 * - 正確實作 SessionRunner 契約（run 回 AsyncIterable<RunnerEvent>）
 * - signal 已 aborted 時立即 yield 'aborted-before-start'
 */
import { describe, expect, test } from 'bun:test'
import { bootstrapDaemonContext } from '../../../src/daemon/sessionBootstrap'
import { createQueryEngineRunner } from '../../../src/daemon/queryEngineRunner'
import type { QueuedInput, RunnerEvent } from '../../../src/daemon/sessionRunner'

async function drain(
  iterable: AsyncIterable<RunnerEvent>,
): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = []
  for await (const e of iterable) out.push(e)
  return out
}

describe('createQueryEngineRunner', () => {
  test('aborted-before-start when signal already aborted', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    const runner = createQueryEngineRunner({ context: ctx })
    const input: QueuedInput = {
      id: 'test-id-01',
      clientId: 'c',
      source: 'repl',
      intent: 'interactive',
      payload: 'hi',
      enqueuedAt: Date.now(),
    }
    const ctrl = new AbortController()
    ctrl.abort()
    const events = await drain(runner.run(input, ctrl.signal))
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe('error')
    expect((events[0] as { type: 'error'; error: string }).error).toBe(
      'aborted-before-start',
    )
    await ctx.dispose()
  })

  test('implements SessionRunner interface', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    const runner = createQueryEngineRunner({ context: ctx })
    expect(typeof runner.run).toBe('function')
    await ctx.dispose()
  })
})
