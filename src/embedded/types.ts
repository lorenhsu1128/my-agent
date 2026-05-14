/**
 * Embedded library public types — 桌寵 virtual-assistant-desktop 內嵌 my-agent 用。
 *
 * Frame schema 與 daemon WS NDJSON 完全相同（見 src/daemon/sessionBroker.ts），
 * 讓桌寵 src-bubble/adapter/daemonFrameAdapter.ts 不需修改即可同時消費
 * 兩種來源（外部 daemon ws / 內嵌 EventEmitter）。
 */
import type { ClientSource } from '../server/clientRegistry.js'
import type { RunnerEvent } from '../daemon/sessionRunner.js'
import type {
  QueueState,
  TurnEndReason,
} from '../daemon/inputQueue.js'

/**
 * 與 daemon `sessionBroker` 廣播的 NDJSON 一致的 frame union。
 */
export type Frame =
  | {
      type: 'hello'
      sessionId: string
      state: QueueState
      currentInputId?: string
    }
  | { type: 'state'; state: QueueState }
  | {
      type: 'turnStart'
      inputId: string
      clientId: string
      source: ClientSource
      startedAt: number
    }
  | {
      type: 'turnEnd'
      inputId: string
      reason: TurnEndReason
      error?: string
      endedAt: number
    }
  | {
      type: 'runnerEvent'
      inputId: string
      event: RunnerEvent
    }

/**
 * Preload 階段（桌寵 toggle ON 時依序通過這些 phase）。
 */
export type PreloadPhase =
  | 'configDir'
  | 'bootstrapContext'
  | 'mcpConnect'
  | 'createSession'
  | 'ready'

export interface PreloadProgress {
  phase: PreloadPhase
  /** 0..1 粗略估計 */
  progress: number
  /** 顯示給使用者的人類訊息（可選） */
  message?: string
}
