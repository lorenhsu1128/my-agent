/**
 * Client registry — daemon 內部追蹤已連線 WS client。
 *
 * 每個 attached client（REPL / Discord adapter / cron runner）都對應一筆紀錄。
 * 提供：
 *   - 登記 / 移除 / 查詢
 *   - broadcast（廣播到所有連線）
 *   - send（點對點）
 *   - snapshot（供 `daemon status` 列出 attached clients）
 *
 * 這一層不認識 WS 協議本身；只把 "socket" 抽成 `{ send, close }` interface，
 * 方便 M-DAEMON-7 的 broadcast / routing 單元測試時 inject fake sockets。
 */
import { logForDebugging } from '../utils/debug.js'

export type ClientSource = 'repl' | 'discord' | 'cron' | 'slash' | 'unknown'

export interface ClientSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface ClientInfo {
  id: string
  source: ClientSource
  connectedAt: number
  remoteAddress?: string
}

export interface RegisteredClient extends ClientInfo {
  socket: ClientSocket
}

export interface ClientRegistry {
  register(client: Omit<RegisteredClient, 'connectedAt'>): RegisteredClient
  unregister(id: string): RegisteredClient | null
  get(id: string): RegisteredClient | null
  list(): ReadonlyArray<ClientInfo>
  count(): number
  broadcast(payload: string, filter?: (c: ClientInfo) => boolean): number
  send(id: string, payload: string): boolean
  closeAll(code?: number, reason?: string): void
}

export function createClientRegistry(): ClientRegistry {
  const clients = new Map<string, RegisteredClient>()

  return {
    register(client) {
      const full: RegisteredClient = {
        ...client,
        connectedAt: Date.now(),
      }
      clients.set(full.id, full)
      return full
    },
    unregister(id) {
      const c = clients.get(id)
      if (!c) return null
      clients.delete(id)
      return c
    },
    get(id) {
      return clients.get(id) ?? null
    },
    list() {
      return Array.from(clients.values()).map(c => ({
        id: c.id,
        source: c.source,
        connectedAt: c.connectedAt,
        remoteAddress: c.remoteAddress,
      }))
    },
    count() {
      return clients.size
    },
    broadcast(payload, filter) {
      let sent = 0
      for (const c of clients.values()) {
        if (filter && !filter(c)) continue
        try {
          c.socket.send(payload)
          sent++
        } catch (err) {
          logForDebugging(
            `[daemon:registry] broadcast failed for ${c.id}: ${err}`,
            { level: 'warn' },
          )
        }
      }
      return sent
    },
    send(id, payload) {
      const c = clients.get(id)
      if (!c) return false
      try {
        c.socket.send(payload)
        return true
      } catch (err) {
        logForDebugging(
          `[daemon:registry] send failed for ${id}: ${err}`,
          { level: 'warn' },
        )
        return false
      }
    },
    closeAll(code, reason) {
      for (const c of clients.values()) {
        try {
          c.socket.close(code, reason)
        } catch {
          // ignore individual close errors
        }
      }
      clients.clear()
    },
  }
}
