/**
 * M-DAEMON-4.5：cronWiring 單元測試。
 *
 * 用 fake cronScheduler module 跟 fake broker 確認：
 *   - gate 關時回 no-op handle（scheduler === null）
 *   - gate 開時 start → scheduler 拿到 onFire / onFireTask / isLoading
 *   - onFireTask 真的會 submit 到 broker.queue
 *   - preRunScript 會被套到 prompt
 *   - stop 轉給底層 scheduler
 */
import { describe, expect, test } from 'bun:test'
import { startDaemonCronWiring } from '../../../src/daemon/cronWiring'
import type { SessionBroker } from '../../../src/daemon/sessionBroker'
import type { CronScheduler } from '../../../src/utils/cronScheduler'
import type { CronTask } from '../../../src/utils/cronTasks'

interface Submitted {
  payload: string
  clientId: string
  source: string
  intent: string
}

function makeFakeBroker(submits: Submitted[]): SessionBroker {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue: {
      submit: (payload: string, opts: {
        clientId: string
        source: string
        intent: string
      }) => {
        submits.push({
          payload,
          clientId: opts.clientId,
          source: opts.source,
          intent: opts.intent,
        })
        return 'fake-id'
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    sessionId: 'fake-session',
    async dispose() {},
  }
}

interface CapturedSchedulerOpts {
  onFire?: (prompt: string) => void
  onFireTask?: (task: CronTask) => void
  isLoading?: () => boolean
  isKilled?: () => boolean
}

function makeFakeModules(
  captured: { opts?: CapturedSchedulerOpts; started: boolean; stopped: boolean },
): Parameters<typeof startDaemonCronWiring>[0]['modules'] {
  const fakeScheduler: CronScheduler = {
    start: () => {
      captured.started = true
    },
    stop: () => {
      captured.stopped = true
    },
    getNextFireTime: () => null,
  }
  return {
    createCronScheduler: (opts): CronScheduler => {
      captured.opts = opts as CapturedSchedulerOpts
      return fakeScheduler
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCronJitterConfig: (() => ({})) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runPreRunScript: (async () => ({ output: 'pre-run-output' })) as any,
    augmentPromptWithPreRun: (prompt, res) =>
      `${prompt}\n<preRun>${(res as { output: string }).output}</preRun>`,
  }
}

describe('startDaemonCronWiring', () => {
  test('gate off → scheduler is null, no-op', () => {
    const submits: Submitted[] = []
    const broker = makeFakeBroker(submits)
    const cap = { started: false, stopped: false }
    const handle = startDaemonCronWiring({
      broker,
      cwd: '/tmp/cron-wiring-test',
      isEnabled: () => false,
      modules: makeFakeModules(cap),
    })
    expect(handle.scheduler).toBeNull()
    expect(cap.started).toBe(false)
    // stop() 是 no-op 不拋錯
    handle.stop()
  })

  test('gate on → scheduler starts with isLoading always false', () => {
    const submits: Submitted[] = []
    const broker = makeFakeBroker(submits)
    const cap = { started: false, stopped: false }
    const handle = startDaemonCronWiring({
      broker,
      cwd: '/tmp/cron-wiring-test',
      isEnabled: () => true,
      modules: makeFakeModules(cap),
    })
    expect(handle.scheduler).not.toBeNull()
    expect(cap.started).toBe(true)
    expect(cap.opts?.isLoading?.()).toBe(false)
    handle.stop()
    expect(cap.stopped).toBe(true)
  })

  test('onFire submits to queue as cron / background', () => {
    const submits: Submitted[] = []
    const broker = makeFakeBroker(submits)
    const cap = { started: false, stopped: false }
    startDaemonCronWiring({
      broker,
      cwd: '/tmp/cron-wiring-test',
      isEnabled: () => true,
      modules: makeFakeModules(cap),
    })
    cap.opts!.onFire!('hello from cron')
    expect(submits.length).toBe(1)
    expect(submits[0]!.payload).toBe('hello from cron')
    expect(submits[0]!.source).toBe('cron')
    expect(submits[0]!.intent).toBe('background')
    expect(submits[0]!.clientId).toBe('daemon-cron')
  })

  test('onFireTask with preRunScript augments prompt', async () => {
    const submits: Submitted[] = []
    const broker = makeFakeBroker(submits)
    const cap = { started: false, stopped: false }
    startDaemonCronWiring({
      broker,
      cwd: '/tmp/cron-wiring-test',
      isEnabled: () => true,
      modules: makeFakeModules(cap),
    })
    const task: CronTask = {
      id: 't1',
      prompt: 'base',
      schedule: '*/5 * * * *',
      preRunScript: 'echo hi',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    cap.opts!.onFireTask!(task)
    await new Promise(r => setTimeout(r, 20))
    expect(submits.length).toBe(1)
    expect(submits[0]!.payload).toContain('base')
    expect(submits[0]!.payload).toContain('pre-run-output')
  })

  test('gate flip mid-run reported via isKilled', () => {
    const submits: Submitted[] = []
    const broker = makeFakeBroker(submits)
    const cap = { started: false, stopped: false }
    let enabled = true
    startDaemonCronWiring({
      broker,
      cwd: '/tmp/cron-wiring-test',
      isEnabled: () => enabled,
      modules: makeFakeModules(cap),
    })
    expect(cap.opts?.isKilled?.()).toBe(false)
    enabled = false
    expect(cap.opts?.isKilled?.()).toBe(true)
  })
})
