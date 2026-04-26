/**
 * M-WEB-4：Per-browser-tab session state。
 *
 * 一個 BrowserSession 對應一個瀏覽器分頁的 WS 連線，由 wsServer 管理。
 * webGateway 透過 BrowserSessionRegistry 廣播事件。
 *
 * 訂閱模型：
 *   - browser 連上後預設不訂閱任何 project（Hello frame 列出可選 projects）
 *   - browser 送 `subscribe` { projectIds } → server 把該 tab 加入這些 project
 *     的廣播 fan-out
 *   - 多個 tab 訂閱同一 project 全會收到事件
 */
import { randomUUID } from 'crypto'
import type { ServerWebSocket } from 'bun'

export interface BrowserSocketData {
  sessionId: string
  remoteAddress?: string
  /** UA 字串（informational only） */
  userAgent?: string
  connectedAt: number
}

export interface BrowserSession {
  readonly id: string
  readonly remoteAddress?: string
  readonly userAgent?: string
  readonly connectedAt: number
  readonly subscribedProjects: ReadonlySet<string>
  /** 上一次收到 client 訊息或回 ping 的時間。 */
  lastActivityAt: number
  /** 寫入此 session 的 WS frame；caller 應該已序列化成 JSON 字串。 */
  send(payload: string): void
  /** 標記訂閱清單。集合語意：傳入清單就是新的完整集合。 */
  setSubscriptions(projectIds: string[]): void
  /** 是否訂閱了某 project。 */
  isSubscribedTo(projectId: string): boolean
  /** 是否訂閱了任何 project（true 表示要送 daemon-global 事件給它）。 */
  hasAnySubscription(): boolean
  /** 主動關閉。 */
  close(reason?: string): void
}

/**
 * BrowserSessionRegistry — 管理當前所有連線的 browser tab。
 * 並提供 broadcast 工具讓 webGateway 把事件推給訂閱者。
 */
export interface BrowserSessionRegistry {
  size(): number
  list(): BrowserSession[]
  get(id: string): BrowserSession | undefined
  /** 內部：建立並註冊。回傳 session（呼叫端要存到 ws.data.sessionId）。 */
  register(opts: {
    ws: ServerWebSocket<BrowserSocketData>
    remoteAddress?: string
    userAgent?: string
  }): BrowserSession
  /** 內部：移除已斷線的 session。 */
  unregister(id: string): void
  /**
   * Broadcast：把 payload 送給所有訂閱了 projectId 的 session。
   * projectId === null 表示 daemon-global 事件（送給所有 hasAnySubscription 的 session）。
   * 回傳成功送出的 session 數。
   */
  broadcast(payload: string, projectId: string | null): number
  /**
   * 廣播給「全部」session（不論訂閱狀態），例如 hello / project.added
   * 這類 lifecycle 事件每個 tab 都該知道。
   */
  broadcastAll(payload: string): number
  /** 點對點送訊息。 */
  send(sessionId: string, payload: string): boolean
  closeAll(reason?: string): void
}

class BrowserSessionImpl implements BrowserSession {
  public readonly id: string
  public readonly remoteAddress: string | undefined
  public readonly userAgent: string | undefined
  public readonly connectedAt: number
  public lastActivityAt: number
  private subs: Set<string> = new Set()

  constructor(
    private readonly ws: ServerWebSocket<BrowserSocketData>,
    private readonly onClose: () => void,
    opts: {
      id: string
      remoteAddress?: string
      userAgent?: string
    },
  ) {
    this.id = opts.id
    this.remoteAddress = opts.remoteAddress
    this.userAgent = opts.userAgent
    this.connectedAt = Date.now()
    this.lastActivityAt = this.connectedAt
  }

  get subscribedProjects(): ReadonlySet<string> {
    return this.subs
  }

  send(payload: string): void {
    try {
      this.ws.send(payload)
    } catch {
      // 連線已關，忽略
    }
  }

  setSubscriptions(projectIds: string[]): void {
    this.subs = new Set(projectIds.filter(s => typeof s === 'string'))
  }

  isSubscribedTo(projectId: string): boolean {
    return this.subs.has(projectId)
  }

  hasAnySubscription(): boolean {
    return this.subs.size > 0
  }

  close(reason?: string): void {
    try {
      this.ws.close(1000, reason)
    } catch {
      // ignore
    }
    this.onClose()
  }
}

export function createBrowserSessionRegistry(): BrowserSessionRegistry {
  const sessions = new Map<string, BrowserSessionImpl>()

  return {
    size: () => sessions.size,
    list: () => [...sessions.values()],
    get: id => sessions.get(id),
    register({ ws, remoteAddress, userAgent }) {
      const id = randomUUID()
      const session = new BrowserSessionImpl(ws, () => sessions.delete(id), {
        id,
        remoteAddress,
        userAgent,
      })
      sessions.set(id, session)
      ws.data.sessionId = id
      ws.data.remoteAddress = remoteAddress
      ws.data.userAgent = userAgent
      ws.data.connectedAt = session.connectedAt
      return session
    },
    unregister(id) {
      sessions.delete(id)
    },
    broadcast(payload, projectId) {
      let n = 0
      for (const s of sessions.values()) {
        const target =
          projectId === null ? s.hasAnySubscription() : s.isSubscribedTo(projectId)
        if (target) {
          s.send(payload)
          n++
        }
      }
      return n
    },
    broadcastAll(payload) {
      let n = 0
      for (const s of sessions.values()) {
        s.send(payload)
        n++
      }
      return n
    },
    send(sessionId, payload) {
      const s = sessions.get(sessionId)
      if (!s) return false
      s.send(payload)
      return true
    },
    closeAll(reason) {
      for (const s of sessions.values()) {
        s.close(reason)
      }
      sessions.clear()
    },
  }
}
