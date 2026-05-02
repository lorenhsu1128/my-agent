/**
 * M-WEB browser ↔ daemon WebSocket client。
 *
 * 設計：
 *   - 自動 reconnect（5s / 10s / 30s backoff，capped）
 *   - heartbeat：30s 沒收到任何訊息則視為 stale，主動關連線觸發重連
 *   - 訂閱 lifecycle：connection / disconnect → 通知 store 顯示 banner
 *   - 訊息派發：接 ServerEvent 統一回 callback；發送則型別檢查 ClientFrame
 */
import type { ClientFrame, ServerEvent } from './types'

export type WsConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

export interface WsClient {
  readonly state: () => WsConnectionState
  readonly url: () => string
  send(frame: ClientFrame): boolean
  subscribe(projectIds: string[]): void
  on(event: 'state', handler: (s: WsConnectionState) => void): () => void
  on(event: 'frame', handler: (f: ServerEvent) => void): () => void
  close(): void
}

export interface WsClientOptions {
  /** 完整 URL，例 `ws://localhost:9090/ws`；不傳預設用同 origin。 */
  url?: string
  /** 重連 backoff 序列（ms）；預設 [1s, 5s, 10s, 30s]，到底重複末項。 */
  backoffMs?: number[]
  /** Stale 偵測：超過此 ms 沒收到任何訊息（含 keepalive）→ 視為斷線。 */
  staleThresholdMs?: number
  /** 測試 inject。 */
  createSocket?: (url: string) => WebSocket
}

const DEFAULT_BACKOFF = [1_000, 5_000, 10_000, 30_000]

function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:9090/ws'
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws`
}

type StateHandler = (s: WsConnectionState) => void
type FrameHandler = (f: ServerEvent) => void

export function createWsClient(opts: WsClientOptions = {}): WsClient {
  const url = opts.url ?? defaultUrl()
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF
  const staleMs = opts.staleThresholdMs ?? 60_000
  const create = opts.createSocket ?? ((u: string) => new WebSocket(u))

  let socket: WebSocket | null = null
  let state: WsConnectionState = 'closed'
  let backoffIdx = 0
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setInterval> | null = null
  let lastMsgAt = Date.now()
  let pendingSubscriptions: string[] = []
  // M-WEB-PARITY-3：lastSeq per project — frame 帶 _seq 回來，重連時送回讓 server replay。
  const lastSeqByProject = new Map<string, number>()

  const stateHandlers: StateHandler[] = []
  const frameHandlers: FrameHandler[] = []

  function setState(next: WsConnectionState): void {
    if (state === next) return
    state = next
    for (const h of stateHandlers) {
      try {
        h(next)
      } catch {
        // ignore
      }
    }
  }

  function emitFrame(f: ServerEvent): void {
    for (const h of frameHandlers) {
      try {
        h(f)
      } catch {
        // ignore
      }
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function startStaleCheck(): void {
    if (staleTimer) return
    staleTimer = setInterval(() => {
      if (Date.now() - lastMsgAt > staleMs) {
        // 主動關連線觸發 onclose → reconnect
        if (socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.close(4000, 'stale')
          } catch {
            // ignore
          }
        }
      }
    }, Math.min(staleMs, 15_000))
  }
  function stopStaleCheck(): void {
    if (staleTimer) {
      clearInterval(staleTimer)
      staleTimer = null
    }
  }

  function connect(): void {
    if (stopped) return
    setState(state === 'closed' ? 'connecting' : 'reconnecting')
    let s: WebSocket
    try {
      s = create(url)
    } catch (err) {
      console.error('[ws] create failed', err)
      scheduleReconnect()
      return
    }
    socket = s
    s.addEventListener('open', () => {
      setState('open')
      backoffIdx = 0
      lastMsgAt = Date.now()
      // 重發訂閱（reconnect 時帶 lastSeq 讓 server 補帧）
      if (pendingSubscriptions.length > 0) {
        sendSubscribeWithLastSeq(pendingSubscriptions)
      }
      startStaleCheck()
    })
    s.addEventListener('message', e => {
      lastMsgAt = Date.now()
      const text = typeof e.data === 'string' ? e.data : ''
      let parsed: ServerEvent | null = null
      try {
        parsed = JSON.parse(text) as ServerEvent
      } catch {
        return
      }
      if (parsed) {
        // M-WEB-PARITY-3：track per-project _seq（server 廣播帶的）
        const anyP = parsed as unknown as { _seq?: number; projectId?: string }
        if (
          typeof anyP._seq === 'number' &&
          typeof anyP.projectId === 'string'
        ) {
          const prev = lastSeqByProject.get(anyP.projectId) ?? 0
          if (anyP._seq > prev) lastSeqByProject.set(anyP.projectId, anyP._seq)
        }
        emitFrame(parsed)
      }
    })
    s.addEventListener('close', () => {
      stopStaleCheck()
      socket = null
      if (stopped) {
        setState('closed')
        return
      }
      scheduleReconnect()
    })
    s.addEventListener('error', () => {
      // close 會緊接著觸發；這邊不主動 close 避免重 fire
    })
  }

  function scheduleReconnect(): void {
    setState('reconnecting')
    const wait = backoff[Math.min(backoffIdx, backoff.length - 1)] ?? 30_000
    backoffIdx++
    clearReconnectTimer()
    reconnectTimer = setTimeout(connect, wait)
  }

  function sendSubscribeWithLastSeq(projectIds: string[]): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const lastSeq: Record<string, number> = {}
    for (const pid of projectIds) {
      const v = lastSeqByProject.get(pid)
      if (v !== undefined) lastSeq[pid] = v
    }
    try {
      socket.send(JSON.stringify({ type: 'subscribe', projectIds, lastSeq }))
      return true
    } catch {
      return false
    }
  }

  function sendRaw(frame: ClientFrame): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  // 立即啟動
  connect()

  return {
    state: () => state,
    url: () => url,
    send(frame) {
      return sendRaw(frame)
    },
    subscribe(projectIds) {
      pendingSubscriptions = [...new Set(projectIds)]
      if (state === 'open') {
        sendSubscribeWithLastSeq(pendingSubscriptions)
      }
    },
    on(event: 'state' | 'frame', handler: StateHandler | FrameHandler) {
      if (event === 'state') {
        stateHandlers.push(handler as StateHandler)
        return () => {
          const i = stateHandlers.indexOf(handler as StateHandler)
          if (i >= 0) stateHandlers.splice(i, 1)
        }
      }
      frameHandlers.push(handler as FrameHandler)
      return () => {
        const i = frameHandlers.indexOf(handler as FrameHandler)
        if (i >= 0) frameHandlers.splice(i, 1)
      }
    },
    close() {
      stopped = true
      clearReconnectTimer()
      stopStaleCheck()
      if (socket) {
        try {
          socket.close()
        } catch {
          // ignore
        }
      }
      setState('closed')
    },
  }
}
