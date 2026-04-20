/**
 * M-DAEMON-6a：狀態機協調 standalone / attached / reconnecting。
 *
 * 綜合 `detectDaemon`（pid.json poll）與 `thinClientSocket`（WS 連線存亡）決定
 * REPL 當下模式，變化時觸發 callback 讓 REPL.tsx 更新 UI + input 路由。
 *
 * Mode：
 *   - `standalone`：daemon 不存在 / 連不上 — 跑本地 query()
 *   - `attached`：daemon alive + socket open — 所有 input 走 WS
 *   - `reconnecting`：之前 attached 但連線掉 — 嘗試重連，UI 顯示 reconnecting
 *
 * 轉換規則（Q1=b 動態）：
 *   - standalone → attached：detector.snapshot.alive 從 false 變 true，connect 成功
 *   - attached → reconnecting：socket close（remote / error）
 *   - reconnecting → attached：重連成功
 *   - reconnecting → standalone：detector 確認 daemon 已死（pid.json 消失 / 不 alive）
 *
 * Q3=a 透明 fallback：reconnecting → standalone 時不阻擋；若當下有 turn in-flight
 *     由 REPL 層決定是否 re-run（本模組只回報狀態）。
 */
import { EventEmitter } from 'node:events'
import type { DaemonDetector, DaemonSnapshot } from './detectDaemon.js'
import type {
  InboundFrame,
  ThinClientSocket,
  ThinClientSocketOptions,
} from './thinClientSocket.js'
import { createThinClientSocket } from './thinClientSocket.js'

export type ClientMode = 'standalone' | 'attached' | 'reconnecting'

export interface FallbackManagerState {
  mode: ClientMode
  snapshot: DaemonSnapshot
  socket: ThinClientSocket | null
}

export interface FallbackManagerOptions {
  detector: DaemonDetector
  host?: string
  /** 重連最大等待；預設 30s。逾時 → standalone。 */
  reconnectTimeoutMs?: number
  /** 每次重連嘗試間隔；預設 1s。 */
  reconnectIntervalMs?: number
  /** 測試 inject：取代 socket factory。 */
  createSocket?: (opts: ThinClientSocketOptions) => ThinClientSocket
}

export interface FallbackManager {
  readonly state: FallbackManagerState
  on(event: 'mode', handler: (mode: ClientMode) => void): void
  on(event: 'frame', handler: (frame: InboundFrame) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  /** 主動送 input；只在 mode === 'attached' 時可用。 */
  sendInput(text: string, intent?: 'interactive' | 'background' | 'slash'): void
  stop(): Promise<void>
}

export function createFallbackManager(
  opts: FallbackManagerOptions,
): FallbackManager {
  const detector = opts.detector
  const host = opts.host ?? '127.0.0.1'
  const createSocket = opts.createSocket ?? createThinClientSocket
  const reconnectTimeoutMs = opts.reconnectTimeoutMs ?? 30_000
  const reconnectIntervalMs = opts.reconnectIntervalMs ?? 1_000
  const emitter = new EventEmitter()

  let mode: ClientMode = 'standalone'
  let socket: ThinClientSocket | null = null
  let reconnectStart: number | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const setMode = (next: ClientMode): void => {
    if (mode === next) return
    mode = next
    emitter.emit('mode', next)
  }

  const cleanupSocket = (): void => {
    if (socket) {
      try {
        socket.close()
      } catch {
        // ignore
      }
      socket = null
    }
  }

  const tryConnect = async (snap: DaemonSnapshot): Promise<boolean> => {
    if (!snap.alive || !snap.port || !snap.token) return false
    cleanupSocket()
    const s = createSocket({
      host,
      port: snap.port,
      token: snap.token,
    })
    s.on('frame', (f: InboundFrame) => emitter.emit('frame', f))
    s.on('close', () => {
      if (disposed) return
      // 只要 daemon 還活著（下次 detector 確認）就試重連。
      if (mode === 'attached') {
        setMode('reconnecting')
        reconnectStart = Date.now()
        scheduleReconnect()
      } else if (mode === 'reconnecting') {
        scheduleReconnect()
      }
    })
    try {
      await s.connect()
    } catch {
      try {
        s.close()
      } catch {
        // ignore
      }
      return false
    }
    socket = s
    return true
  }

  const scheduleReconnect = (): void => {
    if (disposed) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      if (disposed) return
      if (mode !== 'reconnecting') return
      const snap = await detector.check()
      if (!snap.alive) {
        setMode('standalone')
        reconnectStart = null
        cleanupSocket()
        return
      }
      const connected = await tryConnect(snap)
      if (connected) {
        setMode('attached')
        reconnectStart = null
        return
      }
      // 連不上：是否已超時？
      if (
        reconnectStart !== null &&
        Date.now() - reconnectStart > reconnectTimeoutMs
      ) {
        setMode('standalone')
        reconnectStart = null
        cleanupSocket()
        return
      }
      scheduleReconnect()
    }, reconnectIntervalMs)
  }

  const onDaemonChange = async (snap: DaemonSnapshot): Promise<void> => {
    if (disposed) return
    if (snap.alive && mode === 'standalone') {
      const ok = await tryConnect(snap)
      if (ok) setMode('attached')
      // 連不上就維持 standalone；下次 detector change 再試。
    } else if (!snap.alive && (mode === 'attached' || mode === 'reconnecting')) {
      setMode('standalone')
      reconnectStart = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      cleanupSocket()
    }
  }

  detector.on('change', onDaemonChange)

  // 啟動時若 detector 已有 alive snapshot（比如 runImmediately:true 跑完）
  // 也要嘗試 connect。
  if (detector.snapshot.alive) {
    void onDaemonChange(detector.snapshot)
  }

  return {
    get state() {
      return {
        mode,
        snapshot: detector.snapshot,
        socket,
      }
    },
    on(event, handler) {
      emitter.on(event, handler as (...args: unknown[]) => void)
    },
    off(event, handler) {
      emitter.off(event, handler)
    },
    sendInput(text, intent) {
      if (mode !== 'attached' || !socket) {
        throw new Error(`cannot send input in mode=${mode}`)
      }
      socket.send({ type: 'input', text, intent })
    },
    async stop() {
      disposed = true
      detector.off('change', onDaemonChange)
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      cleanupSocket()
      emitter.removeAllListeners()
    },
  }
}
