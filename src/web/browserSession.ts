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
  /**
   * M-WEB-PARITY-3：帶 seq 的 per-project 廣播。
   * - 自動 stamp `_seq` 欄位（單調遞增，per project）
   * - 進 ring buffer（預設 200 frame）讓 reconnect 補帧用
   * - 回傳分配到的 seq（測試 / 客戶端追蹤用）
   */
  broadcastWithSeq(payload: Record<string, unknown>, projectId: string): number
  /**
   * M-WEB-PARITY-3：補帧 — 把 (lastSeq, ...] 之間的所有 ring buffer 內 frame
   * 重送給指定 session。回傳重送的數量。lastSeq 比 ring 最舊還早回 0（無法補，
   * caller 應改用 full refresh）。
   */
  replayTo(sessionId: string, projectId: string, lastSeq: number): number
  /** 點對點送訊息。 */
  send(sessionId: string, payload: string): boolean
  closeAll(reason?: string): void
}

/** Ring buffer size per project — 配合 30s WS timeout × 一般訊息頻率取整 */
export const DEFAULT_RING_SIZE_PER_PROJECT = 200

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

export function createBrowserSessionRegistry(opts?: {
  ringSizePerProject?: number
}): BrowserSessionRegistry {
  const sessions = new Map<string, BrowserSessionImpl>()
  const ringSize = opts?.ringSizePerProject ?? DEFAULT_RING_SIZE_PER_PROJECT
  // projectId → { nextSeq, ring（環狀 buffer，oldest-first 線性化的時候用） }
  const projectState = new Map<
    string,
    { nextSeq: number; ring: { seq: number; payload: string }[] }
  >()
  const ensureProject = (
    projectId: string,
  ): { nextSeq: number; ring: { seq: number; payload: string }[] } => {
    let s = projectState.get(projectId)
    if (!s) {
      s = { nextSeq: 1, ring: [] }
      projectState.set(projectId, s)
    }
    return s
  }

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
    broadcastWithSeq(payload, projectId) {
      const state = ensureProject(projectId)
      const seq = state.nextSeq++
      const stamped = JSON.stringify({ ...payload, _seq: seq })
      // 進 ring（保持 oldest-first；超過 ringSize 砍頭）
      state.ring.push({ seq, payload: stamped })
      if (state.ring.length > ringSize) state.ring.shift()
      // 廣播給訂閱該 project 的 session
      for (const s of sessions.values()) {
        if (s.isSubscribedTo(projectId)) s.send(stamped)
      }
      return seq
    },
    replayTo(sessionId, projectId, lastSeq) {
      const s = sessions.get(sessionId)
      if (!s) return 0
      const state = projectState.get(projectId)
      if (!state) return 0
      // 找 ring 內 seq > lastSeq 的全部送
      let n = 0
      for (const item of state.ring) {
        if (item.seq > lastSeq) {
          s.send(item.payload)
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
