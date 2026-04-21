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
  /**
   * M-DISCORD-2：REPL 的 cwd。daemon 端用來 resolve ProjectRuntime；未設時
   * daemon fallback 到 default runtime（backward compat）。
   */
  cwd?: string
  /** M-DISCORD-2：source hint，預設 'repl'。 */
  source?: 'repl' | 'discord' | 'cron' | 'slash'
  /** 測試 inject：取代 socket factory。 */
  createSocket?: (opts: ThinClientSocketOptions) => ThinClientSocket
}

export interface FallbackManager {
  readonly state: FallbackManagerState
  /** M-DISCORD-2：最近一次 daemon 拒 attach 的理由（project 未 load 等）；連成功一次 reset。 */
  readonly lastAttachRejectedReason: string | null
  on(event: 'mode', handler: (mode: ClientMode) => void): void
  on(event: 'frame', handler: (frame: InboundFrame) => void): void
  on(
    event: 'attachRejected',
    handler: (frame: {
      reason: string
      cwd?: string
      hint?: string
    }) => void,
  ): void
  off(event: string, handler: (...args: unknown[]) => void): void
  /** 主動送 input；只在 mode === 'attached' 時可用。 */
  sendInput(text: string, intent?: 'interactive' | 'background' | 'slash'): void
  /** 送 permissionResponse；只在 attached 時可用。 */
  sendPermissionResponse(
    toolUseID: string,
    decision: 'allow' | 'deny',
    updatedInput?: unknown,
    message?: string,
  ): void
  /** 同步 TUI 當下 permission mode 到 daemon；attached 時才送，否則 no-op。 */
  sendPermissionContextSync(
    mode: import('../../types/permissions.js').PermissionMode,
  ): void
  /**
   * 立刻嘗試 attach（不等 detector poll）。清除 suppressAutoReattach flag。
   * 若 daemon 不 alive 或 connect 失敗回 ok:false + reason。
   */
  forceAttach(): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * 立刻 detach 回 standalone，停 reconnect，並設 suppressAutoReattach flag
   * （擋 detector 下一輪 poll 自動重 attach）。下次 forceAttach 會清除旗標。
   */
  forceDetach(): Promise<void>
  /**
   * 向 daemon 查當前狀態（replCount / discordEnabled）。超時或非 attached 時
   * 回 null；caller 自己決定 fallback 行為。
   */
  queryDaemonStatus(
    timeoutMs?: number,
  ): Promise<{ replCount: number; discordEnabled: boolean } | null>
  /**
   * M-DISCORD-AUTOBIND：`/discord-bind` RPC — 委託 daemon 呼 discord.js 建 guild channel
   * 並寫回 channelBindings。非 attached 或 timeout 回 null。
   */
  discordBind(
    cwd: string,
    timeoutMs?: number,
  ): Promise<
    | {
        ok: true
        channelId: string
        channelName?: string
        url?: string
        alreadyBound?: boolean
      }
    | { ok: false; error: string }
    | null
  >
  /**
   * `/discord-unbind` RPC — rename channel `unbound-<name>` + 清 binding。
   */
  discordUnbind(
    cwd: string,
    timeoutMs?: number,
  ): Promise<{ ok: true } | { ok: false; error: string } | null>
  /**
   * M-DISCORD-ADMIN：一體化 admin RPC — whitelist/invite/guilds。
   * `op` 由 caller 指定；payload 欄位與 op 對應。非 attached / timeout 回 null。
   */
  discordAdmin(
    req: DiscordAdminPayload,
    timeoutMs?: number,
  ): Promise<DiscordAdminResponse | null>
  stop(): Promise<void>
}

export type DiscordAdminPayload =
  | { op: 'whitelistAdd'; userId: string }
  | { op: 'whitelistRemove'; userId: string }
  | { op: 'invite' }
  | { op: 'guilds' }
  | {
      op: 'bindChannel'
      channelId: string
      projectPath: string
      autoRegister?: boolean
    }
  | { op: 'unbindChannel'; channelId: string }

export type DiscordAdminResponse =
  | { ok: true; op: 'whitelistAdd' | 'whitelistRemove'; changed: boolean }
  | { ok: true; op: 'invite'; inviteUrl: string; appId: string }
  | {
      ok: true
      op: 'guilds'
      guilds: Array<{ id: string; name: string; memberCount: number }>
    }
  | {
      ok: true
      op: 'bindChannel'
      channelId: string
      channelName: string
      guildId: string
      guildName: string
      autoRegistered?: boolean
      existingChannels?: string[]
    }
  | {
      ok: true
      op: 'unbindChannel'
      channelId: string
      changed: boolean
      previousPath?: string
    }
  | { ok: false; op: DiscordAdminPayload['op']; error: string }

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
  /**
   * `/daemon detach` 設 true 後，detector 下一輪 poll 看到 daemon 仍 alive
   * 不會自動觸發 attach。`forceAttach` 成功（或呼叫時）會清除此 flag。
   * 手動要求的一次性 opt-out，不進 config；REPL 重啟就歸零。
   */
  let suppressAutoReattach = false

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

  let attachRejectedReason: string | null = null
  /** 等待中的 queryDaemonStatus 請求，key = requestId。 */
  const pendingStatusQueries = new Map<
    string,
    {
      resolve: (
        v: { replCount: number; discordEnabled: boolean } | null,
      ) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let nextQueryId = 1

  /** M-DISCORD-AUTOBIND：pending discord.bind / discord.unbind response */
  type DiscordBindResolve =
    | ((v: {
        ok: true
        channelId: string
        channelName?: string
        url?: string
        alreadyBound?: boolean
      } | { ok: false; error: string } | null) => void)
  type DiscordUnbindResolve =
    | ((v: { ok: true } | { ok: false; error: string } | null) => void)
  const pendingDiscordBind = new Map<
    string,
    { resolve: DiscordBindResolve; timer: ReturnType<typeof setTimeout> }
  >()
  const pendingDiscordUnbind = new Map<
    string,
    { resolve: DiscordUnbindResolve; timer: ReturnType<typeof setTimeout> }
  >()
  /** M-DISCORD-ADMIN：pending discord.admin response（whitelist / invite / guilds） */
  type DiscordAdminResolve = (v: DiscordAdminResponse | null) => void
  const pendingDiscordAdmin = new Map<
    string,
    { resolve: DiscordAdminResolve; timer: ReturnType<typeof setTimeout> }
  >()

  const tryConnect = async (snap: DaemonSnapshot): Promise<boolean> => {
    if (!snap.alive || !snap.port || !snap.token) return false
    cleanupSocket()
    // 進 tryConnect 即視為「新嘗試」，清掉上次的 reject 標記；避免 attachRejected
    // frame 在 step5 被誤清（daemon 可能在 open 後立刻送 reject）。
    attachRejectedReason = null
    const s = createSocket({
      host,
      port: snap.port,
      token: snap.token,
      cwd: opts.cwd,
      source: opts.source ?? 'repl',
    })
    s.on('frame', (f: InboundFrame) => {
      // M-DISCORD-2：daemon 拒絕 attach（project 未 load）→ 關 socket，標記
      // rejected，設 mode=standalone，emit 一次性 attachRejected 事件讓 REPL
      // 顯示 warning。後續不再自動重試（避免無謂 reconnect loop）。
      // daemonStatus response → resolve 對應 pending query
      if (f.type === 'discord.bindResult') {
        const rid = String((f as { requestId?: unknown }).requestId ?? '')
        const pending = pendingDiscordBind.get(rid)
        if (pending) {
          clearTimeout(pending.timer)
          pendingDiscordBind.delete(rid)
          const p = f as unknown as {
            ok?: boolean
            channelId?: string
            channelName?: string
            url?: string
            alreadyBound?: boolean
            error?: string
          }
          if (p.ok) {
            pending.resolve({
              ok: true,
              channelId: String(p.channelId ?? ''),
              channelName: p.channelName,
              url: p.url,
              alreadyBound: p.alreadyBound,
            })
          } else {
            pending.resolve({
              ok: false,
              error: String(p.error ?? 'unknown'),
            })
          }
        }
        return
      }
      if (f.type === 'discord.adminResult') {
        const rid = String((f as { requestId?: unknown }).requestId ?? '')
        const pending = pendingDiscordAdmin.get(rid)
        if (pending) {
          clearTimeout(pending.timer)
          pendingDiscordAdmin.delete(rid)
          const p = f as unknown as {
            ok?: boolean
            op?: string
            error?: string
            changed?: boolean
            inviteUrl?: string
            appId?: string
            guilds?: Array<{ id: string; name: string; memberCount: number }>
            channelId?: string
            channelName?: string
            guildId?: string
            guildName?: string
            autoRegistered?: boolean
            existingChannels?: string[]
            previousPath?: string
          }
          const op = String(p.op ?? 'invite') as DiscordAdminPayload['op']
          if (p.ok) {
            if (op === 'invite') {
              pending.resolve({
                ok: true,
                op: 'invite',
                inviteUrl: String(p.inviteUrl ?? ''),
                appId: String(p.appId ?? ''),
              })
            } else if (op === 'guilds') {
              pending.resolve({
                ok: true,
                op: 'guilds',
                guilds: Array.isArray(p.guilds) ? p.guilds : [],
              })
            } else if (op === 'bindChannel') {
              pending.resolve({
                ok: true,
                op: 'bindChannel',
                channelId: String(p.channelId ?? ''),
                channelName: String(p.channelName ?? ''),
                guildId: String(p.guildId ?? ''),
                guildName: String(p.guildName ?? ''),
                ...(p.autoRegistered && { autoRegistered: true }),
                ...(Array.isArray(p.existingChannels) &&
                  p.existingChannels.length > 0 && {
                    existingChannels: p.existingChannels,
                  }),
              })
            } else if (op === 'unbindChannel') {
              pending.resolve({
                ok: true,
                op: 'unbindChannel',
                channelId: String(p.channelId ?? ''),
                changed: Boolean(p.changed),
                ...(p.previousPath && { previousPath: p.previousPath }),
              })
            } else {
              pending.resolve({
                ok: true,
                op: op as 'whitelistAdd' | 'whitelistRemove',
                changed: Boolean(p.changed),
              })
            }
          } else {
            pending.resolve({
              ok: false,
              op,
              error: String(p.error ?? 'unknown'),
            })
          }
        }
        return
      }
      if (f.type === 'discord.unbindResult') {
        const rid = String((f as { requestId?: unknown }).requestId ?? '')
        const pending = pendingDiscordUnbind.get(rid)
        if (pending) {
          clearTimeout(pending.timer)
          pendingDiscordUnbind.delete(rid)
          const p = f as unknown as { ok?: boolean; error?: string }
          if (p.ok) {
            pending.resolve({ ok: true })
          } else {
            pending.resolve({
              ok: false,
              error: String(p.error ?? 'unknown'),
            })
          }
        }
        return
      }
      if (f.type === 'daemonStatus') {
        const rid = String((f as { requestId?: unknown }).requestId ?? '')
        const pending = pendingStatusQueries.get(rid)
        if (pending) {
          clearTimeout(pending.timer)
          pendingStatusQueries.delete(rid)
          const payload = f as unknown as {
            replCount?: number
            discordEnabled?: boolean
          }
          pending.resolve({
            replCount: Number(payload.replCount ?? 0),
            discordEnabled: Boolean(payload.discordEnabled),
          })
        }
        return
      }
      if (f.type === 'attachRejected') {
        attachRejectedReason = String(
          (f as { reason?: unknown }).reason ?? 'rejected',
        )
        emitter.emit('attachRejected', f)
        try {
          s.close()
        } catch {
          // ignore
        }
        setMode('standalone')
        return
      }
      emitter.emit('frame', f)
    })
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
    // M-DISCORD-2：被 daemon 拒絕 attach 後不再自動重試 — 拒絕通常是 project
    // 沒 load，單純重 connect 沒意義；使用者需手動 `my-agent daemon load` 再開新 REPL。
    if (attachRejectedReason !== null) return
    // `/daemon detach` 要求抑制自動 re-attach；detector 看到 daemon 活著也忽略。
    if (suppressAutoReattach) return
    if (snap.alive && mode === 'standalone') {
      const ok = await tryConnect(snap)
      // Race guard：若 daemon 於 open 後立刻送 attachRejected，frame handler
      // 可能已經把 reason 設好且 setMode('standalone')；此處不能蓋掉回 attached。
      if (ok && attachRejectedReason === null) setMode('attached')
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
    get lastAttachRejectedReason() {
      return attachRejectedReason
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
    sendPermissionResponse(toolUseID, decision, updatedInput, message) {
      if (mode !== 'attached' || !socket) {
        throw new Error(`cannot send permissionResponse in mode=${mode}`)
      }
      socket.send({
        type: 'permissionResponse',
        toolUseID,
        decision,
        updatedInput,
        message,
      })
    },
    sendPermissionContextSync(permissionMode) {
      // Silent no-op when not attached — 同步語意本來就 best-effort。
      if (mode !== 'attached' || !socket) return
      try {
        socket.send({ type: 'permissionContextSync', mode: permissionMode })
      } catch {
        // ignore transient send error
      }
    },
    async forceAttach() {
      if (disposed) return { ok: false as const, reason: 'disposed' }
      suppressAutoReattach = false
      attachRejectedReason = null
      if (mode === 'attached') return { ok: true as const }
      const snap = await detector.check()
      // Yield so any onDaemonChange triggered by detector.check() can run
      // its tryConnect before we check mode again — avoids double-connect.
      await new Promise(r => setTimeout(r, 0))
      if (mode === 'attached') return { ok: true as const }
      if (!snap.alive) return { ok: false as const, reason: 'daemonOffline' }
      const ok = await tryConnect(snap)
      if (ok && attachRejectedReason === null) {
        setMode('attached')
        return { ok: true as const }
      }
      if (attachRejectedReason !== null) {
        return { ok: false as const, reason: attachRejectedReason }
      }
      return { ok: false as const, reason: 'connectFailed' }
    },
    async forceDetach() {
      suppressAutoReattach = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      reconnectStart = null
      // 清 pending queries（detach 後沒 socket 沒人 resolve）
      for (const p of pendingStatusQueries.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingStatusQueries.clear()
      for (const p of pendingDiscordBind.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingDiscordBind.clear()
      for (const p of pendingDiscordUnbind.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingDiscordUnbind.clear()
      cleanupSocket()
      setMode('standalone')
    },
    async queryDaemonStatus(timeoutMs = 2_000) {
      if (mode !== 'attached' || !socket) return null
      const requestId = `q${nextQueryId++}-${Date.now()}`
      return await new Promise<
        { replCount: number; discordEnabled: boolean } | null
      >(resolve => {
        const timer = setTimeout(() => {
          pendingStatusQueries.delete(requestId)
          resolve(null)
        }, timeoutMs)
        pendingStatusQueries.set(requestId, { resolve, timer })
        try {
          // send() 型別只收 OutboundFrame union；這裡繞過（daemon 端接 unknown）。
          ;(
            socket as unknown as {
              send: (f: { type: string; requestId: string }) => void
            }
          ).send({ type: 'queryDaemonStatus', requestId })
        } catch {
          clearTimeout(timer)
          pendingStatusQueries.delete(requestId)
          resolve(null)
        }
      })
    },
    async discordBind(cwd, timeoutMs = 15_000) {
      if (mode !== 'attached' || !socket) return null
      const requestId = `dbind${nextQueryId++}-${Date.now()}`
      return await new Promise<
        | { ok: true; channelId: string; channelName?: string; url?: string; alreadyBound?: boolean }
        | { ok: false; error: string }
        | null
      >(resolve => {
        const timer = setTimeout(() => {
          pendingDiscordBind.delete(requestId)
          resolve(null)
        }, timeoutMs)
        pendingDiscordBind.set(requestId, { resolve, timer })
        try {
          ;(
            socket as unknown as {
              send: (f: {
                type: string
                requestId: string
                cwd: string
              }) => void
            }
          ).send({ type: 'discord.bind', requestId, cwd })
        } catch {
          clearTimeout(timer)
          pendingDiscordBind.delete(requestId)
          resolve(null)
        }
      })
    },
    async discordUnbind(cwd, timeoutMs = 10_000) {
      if (mode !== 'attached' || !socket) return null
      const requestId = `dunbind${nextQueryId++}-${Date.now()}`
      return await new Promise<
        { ok: true } | { ok: false; error: string } | null
      >(resolve => {
        const timer = setTimeout(() => {
          pendingDiscordUnbind.delete(requestId)
          resolve(null)
        }, timeoutMs)
        pendingDiscordUnbind.set(requestId, { resolve, timer })
        try {
          ;(
            socket as unknown as {
              send: (f: {
                type: string
                requestId: string
                cwd: string
              }) => void
            }
          ).send({ type: 'discord.unbind', requestId, cwd })
        } catch {
          clearTimeout(timer)
          pendingDiscordUnbind.delete(requestId)
          resolve(null)
        }
      })
    },
    async discordAdmin(req, timeoutMs = 10_000) {
      if (mode !== 'attached' || !socket) return null
      const requestId = `dadm${nextQueryId++}-${Date.now()}`
      return await new Promise<DiscordAdminResponse | null>(resolve => {
        const timer = setTimeout(() => {
          pendingDiscordAdmin.delete(requestId)
          resolve(null)
        }, timeoutMs)
        pendingDiscordAdmin.set(requestId, { resolve, timer })
        try {
          const frame: {
            type: 'discord.admin'
            requestId: string
            op: DiscordAdminPayload['op']
            userId?: string
            channelId?: string
            projectPath?: string
            autoRegister?: boolean
          } = {
            type: 'discord.admin',
            requestId,
            op: req.op,
          }
          if (req.op === 'whitelistAdd' || req.op === 'whitelistRemove') {
            frame.userId = req.userId
          } else if (req.op === 'bindChannel') {
            frame.channelId = req.channelId
            frame.projectPath = req.projectPath
            if (req.autoRegister) frame.autoRegister = true
          } else if (req.op === 'unbindChannel') {
            frame.channelId = req.channelId
          }
          ;(
            socket as unknown as {
              send: (f: Record<string, unknown>) => void
            }
          ).send(frame)
        } catch {
          clearTimeout(timer)
          pendingDiscordAdmin.delete(requestId)
          resolve(null)
        }
      })
    },
    async stop() {
      disposed = true
      detector.off('change', onDaemonChange)
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      for (const p of pendingStatusQueries.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingStatusQueries.clear()
      for (const p of pendingDiscordBind.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingDiscordBind.clear()
      for (const p of pendingDiscordUnbind.values()) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      pendingDiscordUnbind.clear()
      cleanupSocket()
      emitter.removeAllListeners()
    },
  }
}
