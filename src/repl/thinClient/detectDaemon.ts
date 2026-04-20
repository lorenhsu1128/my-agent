/**
 * M-DAEMON-6a：REPL 端 daemon 偵測。
 *
 * REPL 掛載後定期 poll pid.json + token + heartbeat，回報目前 daemon 活性。
 * Daemon 啟動 / 停止都能被偵測（Q1=b：中途切換）。
 *
 * 純邏輯、無 UI。REPL 層訂 `subscribe` 決定何時 attach / fallback。
 */
import { EventEmitter } from 'node:events'
import { isDaemonAliveSync } from '../../daemon/pidFile.js'
import { readPidFile, type PidFileData } from '../../daemon/pidFile.js'
import { readToken } from '../../daemon/authToken.js'

export interface DaemonSnapshot {
  alive: boolean
  pid?: number
  port?: number
  agentVersion?: string
  token?: string
  lastHeartbeat?: number
  detectedAt: number
}

export interface DetectDaemonOptions {
  baseDir?: string
  /** Poll 間隔；預設 2000ms。 */
  pollIntervalMs?: number
  /** 起始第一次偵測是否立即執行（預設 true）。 */
  runImmediately?: boolean
}

export interface DaemonDetector {
  /** 目前 snapshot（未跑過 `check()` 前 alive:false）。 */
  readonly snapshot: DaemonSnapshot
  /** 手動觸發一次偵測；回新 snapshot。 */
  check(): Promise<DaemonSnapshot>
  /** 變化時觸發（alive 轉換 / port 改變 / token 改變）。 */
  on(event: 'change', handler: (snap: DaemonSnapshot) => void): void
  off(event: 'change', handler: (snap: DaemonSnapshot) => void): void
  /** 停止 poll。 */
  stop(): void
}

export function createDaemonDetector(
  opts: DetectDaemonOptions = {},
): DaemonDetector {
  const baseDir = opts.baseDir
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000
  const emitter = new EventEmitter()

  let snapshot: DaemonSnapshot = {
    alive: false,
    detectedAt: Date.now(),
  }
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const equal = (a: DaemonSnapshot, b: DaemonSnapshot): boolean => {
    return (
      a.alive === b.alive &&
      a.pid === b.pid &&
      a.port === b.port &&
      a.token === b.token &&
      a.agentVersion === b.agentVersion
    )
  }

  const check = async (): Promise<DaemonSnapshot> => {
    const aliveSync = isDaemonAliveSync(baseDir)
    let next: DaemonSnapshot
    if (!aliveSync) {
      next = { alive: false, detectedAt: Date.now() }
    } else {
      const pid: PidFileData | null = await readPidFile(baseDir)
      if (!pid) {
        next = { alive: false, detectedAt: Date.now() }
      } else {
        const token = await readToken(baseDir)
        next = {
          alive: true,
          pid: pid.pid,
          port: pid.port,
          agentVersion: pid.agentVersion,
          lastHeartbeat: pid.lastHeartbeat,
          token: token ?? undefined,
          detectedAt: Date.now(),
        }
      }
    }
    const changed = !equal(snapshot, next)
    snapshot = next
    if (changed) emitter.emit('change', next)
    return next
  }

  const loop = (): void => {
    if (stopped) return
    void check().finally(() => {
      if (stopped) return
      timer = setTimeout(loop, pollIntervalMs)
    })
  }

  if (opts.runImmediately !== false) {
    void check().then(() => {
      if (!stopped) {
        timer = setTimeout(loop, pollIntervalMs)
      }
    })
  } else {
    timer = setTimeout(loop, pollIntervalMs)
  }

  return {
    get snapshot() {
      return snapshot
    },
    check,
    on(event, handler) {
      emitter.on(event, handler as (snap: DaemonSnapshot) => void)
    },
    off(event, handler) {
      emitter.off(event, handler as (snap: DaemonSnapshot) => void)
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      emitter.removeAllListeners()
    },
  }
}
