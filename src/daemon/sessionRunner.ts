/**
 * SessionRunner interface — InputQueue 和 daemon 的業務層之間的解耦契約。
 *
 * M-DAEMON-5 只定義 interface 與 EchoRunner（測試/驗收用假實作）。
 * M-DAEMON-4 之後才會有 QueryEngineRunner（真接 src/QueryEngine.ts 的 `ask()`）。
 *
 * Runner 是**純串流**：吃一筆 QueuedInput 吐一串 RunnerEvent。
 * 生命週期由 InputQueue 控制（queue 決定何時啟動、abort）。
 * Runner 自己不做：
 *   - State 機（由 queue 管 IDLE/RUNNING/INTERRUPTING）
 *   - 訊息 broadcast（由 broker 把 RunnerEvent 轉送給 attached clients）
 *   - Session JSONL 寫入（M-DAEMON-4 才加）
 */
import type { ClientSource } from '../server/clientRegistry.js'

export type QueuedInputIntent =
  /** 使用者互動訊息；會 interrupt 當前 turn（repl/discord 預設） */
  | 'interactive'
  /** 背景觸發；排 FIFO queue，不 interrupt（cron/unknown 預設） */
  | 'background'
  /** Slash command；立即執行不 queue（由 broker 層特別處理；M-DAEMON-7 接） */
  | 'slash'

export interface QueuedInput {
  /** Queue-assigned UUID。 */
  id: string
  clientId: string
  source: ClientSource
  intent: QueuedInputIntent
  /** 使用者訊息原文（text or structured content block）。 */
  payload: unknown
  enqueuedAt: number
}

export type RunnerEvent =
  /** Runner 產生的資料 chunk（SDK message / stream event / plain text…） */
  | { type: 'output'; payload: unknown }
  /** Runner 因 abort / 錯誤結束；error 欄位保留給 broker 顯示給 source client */
  | { type: 'error'; error: string }
  /** Runner 完成一個 turn（成功路徑）。 */
  | { type: 'done' }

export interface SessionRunner {
  /**
   * 執行一個 input。串流事件直到收到 done / error / abort。
   * 必須響應 signal.aborted：看到 abort 時盡快 yield error + 結束。
   */
  run(
    input: QueuedInput,
    signal: AbortSignal,
  ): AsyncIterable<RunnerEvent>
}

/**
 * 最小的 echo runner — 把 input.payload 原樣 yield 回去當 output，然後 done。
 * 供 InputQueue 測試、M-DAEMON 早期 e2e 冒煙用。M-DAEMON-4 由真的
 * QueryEngineRunner 取代（此 echo runner 保留作為 `--echo-mode` 偵錯後端）。
 */
export const echoRunner: SessionRunner = {
  async *run(input, signal) {
    if (signal.aborted) {
      yield { type: 'error', error: 'aborted-before-start' }
      return
    }
    yield { type: 'output', payload: input.payload }
    yield { type: 'done' }
  },
}

/**
 * Delay-able echo runner；測試 interrupt / queue 用。
 * 每個 output chunk 之間 sleep `perChunkDelayMs`；整個 run 產生
 * `chunks` 個 output 後才 done。在 sleep 期間收到 abort 會立即 yield error。
 */
export function createDelayedEchoRunner(opts: {
  chunks?: number
  perChunkDelayMs?: number
}): SessionRunner {
  const chunks = opts.chunks ?? 3
  const delay = opts.perChunkDelayMs ?? 10
  return {
    async *run(input, signal) {
      for (let i = 0; i < chunks; i++) {
        if (signal.aborted) {
          yield { type: 'error', error: 'aborted' }
          return
        }
        await sleepAbortable(delay, signal)
        if (signal.aborted) {
          yield { type: 'error', error: 'aborted' }
          return
        }
        yield { type: 'output', payload: { chunk: i, from: input.id } }
      }
      yield { type: 'done' }
    },
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
