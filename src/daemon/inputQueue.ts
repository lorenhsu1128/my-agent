/**
 * Input queue + 混合 interrupt/queue 狀態機（ADR-M-DAEMON-05）。
 *
 * 狀態：
 *   IDLE         無執行中 turn；下個 submit 立即啟動
 *   RUNNING      有 turn 在跑；SessionRunner 產生 RunnerEvent
 *   INTERRUPTING 已送 abort signal，等 runner 優雅結束
 *
 * 進線規則（依 QueuedInput.intent）：
 *   interactive  IDLE → RUNNING 啟動；RUNNING → INTERRUPTING 中斷當前、搶占
 *   background   IDLE → RUNNING 啟動；RUNNING → 排 FIFO 在後面
 *   slash        IDLE → RUNNING 啟動；RUNNING → 排 FIFO 在 *前面*（M-DAEMON-7
 *                會把 slash 抬成真正的 out-of-band 通道；此處先當高優先權 queue）
 *
 * 事件：
 *   - 'state' 變化（'IDLE'/'RUNNING'/'INTERRUPTING'）
 *   - 'runnerEvent'（所有 RunnerEvent，含 input 脈絡）
 *   - 'turnStart' / 'turnEnd'（input 起訖，含 reason: 'done'/'error'/'aborted'）
 *
 * Queue 對 runner 不認識任何細節 — 純粹控制啟動與 abort；真正業務（session
 * JSONL、Discord broadcast）在 broker 層訂閱 events 再反應。
 */
import { randomUUID } from 'crypto'
import { EventEmitter } from 'node:events'
import type {
  QueuedInput,
  QueuedInputIntent,
  RunnerEvent,
  SessionRunner,
} from './sessionRunner.js'
import type { ClientSource } from '../server/clientRegistry.js'

export type QueueState = 'IDLE' | 'RUNNING' | 'INTERRUPTING'

export type TurnEndReason = 'done' | 'error' | 'aborted'

export interface InputQueueOptions {
  runner: SessionRunner
  /**
   * 強制中斷等待時間（收到 interactive 後 abort 當前 turn，最多等這麼久
   * 讓 runner 自己收尾；逾時還沒完成會視為 runner 卡死，直接 force-IDLE
   * 並開新 turn）。
   * 預設 3s。
   */
  interruptGraceMs?: number
}

export interface TurnStartEvent {
  input: QueuedInput
  startedAt: number
}

export interface TurnEndEvent {
  input: QueuedInput
  endedAt: number
  reason: TurnEndReason
  error?: string
}

export interface RunnerEventWrapper {
  input: QueuedInput
  event: RunnerEvent
}

export interface InputQueue {
  readonly state: QueueState
  readonly pendingCount: number
  readonly currentInput: QueuedInput | null
  /**
   * 送一筆 input 進來。回傳 QueuedInput.id（同步分配 UUID）。
   * 真正執行（RUNNING / 排隊）是非同步的，觀察 events。
   */
  submit(
    payload: unknown,
    opts: {
      clientId: string
      source: ClientSource
      intent: QueuedInputIntent
    },
  ): string
  on(event: 'state', handler: (s: QueueState) => void): void
  on(event: 'runnerEvent', handler: (e: RunnerEventWrapper) => void): void
  on(event: 'turnStart', handler: (e: TurnStartEvent) => void): void
  on(event: 'turnEnd', handler: (e: TurnEndEvent) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  /**
   * 中斷當前 turn（不送替代輸入）。state === IDLE 為 no-op。
   * 內部邏輯與 interrupt+replace 共用：送 abort signal、等 grace、必要時
   * 強制 emit synthetic turnEnd 並清狀態。回傳 resolve 時 state === IDLE。
   */
  abort(): Promise<void>
  /** 停掉 queue：中止當前、清空 pending、拒絕未來 submit。 */
  dispose(): Promise<void>
}

const DEFAULT_INTERRUPT_GRACE_MS = 3_000

export function createInputQueue(opts: InputQueueOptions): InputQueue {
  const runner = opts.runner
  const interruptGraceMs = opts.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS

  const emitter = new EventEmitter()
  let state: QueueState = 'IDLE'
  const pending: QueuedInput[] = []
  let current: QueuedInput | null = null
  let currentController: AbortController | null = null
  let disposed = false

  const setState = (next: QueueState): void => {
    if (state === next) return
    state = next
    emitter.emit('state', next)
  }

  const pickNext = (): QueuedInput | undefined => {
    return pending.shift()
  }

  /**
   * 啟動一個 input 的 run（假設 state 已是 IDLE，caller 已處理好前一個）。
   */
  const runInput = async (input: QueuedInput): Promise<void> => {
    current = input
    // Snapshot 給本次 runInput 用。currentController 是 module-scoped 可能被
    // abortCurrent 的 force-clear path 設成 null，這裡用 local ref 避免 NPE。
    const ac = new AbortController()
    currentController = ac
    setState('RUNNING')
    emitter.emit('turnStart', { input, startedAt: Date.now() })

    let reason: TurnEndReason = 'done'
    let errMsg: string | undefined

    try {
      for await (const event of runner.run(input, ac.signal)) {
        emitter.emit('runnerEvent', { input, event })
        if (event.type === 'error') {
          reason = ac.signal.aborted ? 'aborted' : 'error'
          errMsg = event.error
          break
        }
        if (event.type === 'done') {
          reason = 'done'
          break
        }
      }
    } catch (e) {
      reason = ac.signal.aborted ? 'aborted' : 'error'
      errMsg = String(e)
      emitter.emit('runnerEvent', {
        input,
        event: { type: 'error', error: errMsg },
      } satisfies RunnerEventWrapper)
    }

    // 若 abortCurrent 的 force-clear 已 emit synthetic turnEnd 並把 current
    // 清成 null，這裡就不要重複 emit（避免兩個 turnEnd 給同一 input）。
    if (current === input) {
      emitter.emit('turnEnd', {
        input,
        endedAt: Date.now(),
        reason,
        error: errMsg,
      })
      current = null
      currentController = null
    }

    // 轉下一筆
    if (!disposed) {
      const next = pickNext()
      if (next) {
        setState('IDLE') // 短暫回 IDLE 再進 RUNNING，讓 state 訂閱者看到轉折
        void runInput(next)
      } else {
        setState('IDLE')
      }
    } else {
      setState('IDLE')
    }
  }

  /**
   * 發 abort signal、等 runner 自然結束（runInput 的 finally 會把 state 轉回）；
   * 逾時則強制 emit synthetic turnEnd + 清狀態。state === IDLE 為 no-op。
   * 並發呼叫安全（state 已是 INTERRUPTING 時不重複發 abort）。
   */
  const abortCurrent = async (): Promise<void> => {
    if (state === 'IDLE') return
    if (state !== 'INTERRUPTING') {
      setState('INTERRUPTING')
      currentController?.abort()
    }
    const grace = interruptGraceMs
    const started = Date.now()
    while (state !== 'IDLE' && Date.now() - started < grace) {
      await new Promise(r => setTimeout(r, 5))
    }
    if (state !== 'IDLE') {
      // Runner 卡住：強制清，模擬 turnEnd aborted
      if (current) {
        emitter.emit('turnEnd', {
          input: current,
          endedAt: Date.now(),
          reason: 'aborted',
          error: 'runner stuck, force-cleared after interrupt grace',
        })
      }
      current = null
      currentController = null
      setState('IDLE')
    }
  }

  /**
   * 中斷當前 + 安排替代輸入啟動（interactive intent 的 preempt 流程）。
   */
  const interruptAndReplace = async (
    replacement: QueuedInput,
  ): Promise<void> => {
    await abortCurrent()
    if (!disposed) {
      void runInput(replacement)
    }
  }

  return {
    get state() {
      return state
    },
    get pendingCount() {
      return pending.length
    },
    get currentInput() {
      return current
    },
    submit(payload, opts) {
      if (disposed) {
        throw new Error('InputQueue disposed; cannot submit')
      }
      const input: QueuedInput = {
        id: randomUUID(),
        clientId: opts.clientId,
        source: opts.source,
        intent: opts.intent,
        payload,
        enqueuedAt: Date.now(),
      }
      if (state === 'IDLE') {
        void runInput(input)
      } else if (input.intent === 'interactive') {
        // Interrupt current + replace
        void interruptAndReplace(input)
      } else if (input.intent === 'slash') {
        // 優先權 queue 頭
        pending.unshift(input)
      } else {
        // background: FIFO 尾
        pending.push(input)
      }
      return input.id
    },
    on(event, handler) {
      emitter.on(event, handler as (...args: unknown[]) => void)
    },
    off(event, handler) {
      emitter.off(event, handler)
    },
    async abort() {
      if (disposed) return
      await abortCurrent()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      pending.length = 0
      if (currentController && !currentController.signal.aborted) {
        currentController.abort()
      }
      // 等 runInput 收尾
      const deadline = Date.now() + interruptGraceMs
      while (state !== 'IDLE' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5))
      }
      emitter.removeAllListeners()
    },
  }
}

/**
 * 依 ClientSource 推論預設 intent。Broker 可 override（例如收到 `/reset`
 * slash command 時把 source=repl 的訊息 intent 改成 'slash'）。
 */
export function defaultIntentForSource(source: ClientSource): QueuedInputIntent {
  switch (source) {
    case 'repl':
    case 'discord':
    case 'web':
    case 'mascot':
      return 'interactive'
    case 'cron':
      return 'background'
    case 'slash':
      return 'slash'
    case 'unknown':
    default:
      return 'background'
  }
}
