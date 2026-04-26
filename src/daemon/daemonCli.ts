/**
 * Daemon CLI 子命令實作（`my-agent daemon <subcommand>`）。
 *
 * Subcommand：
 *   start [--port N] [--host H] [--foreground]
 *     - 預設 foreground（阻塞終端，Ctrl+C 停止）
 *     - --foreground 顯式 foreground（方便 systemd/launchd 用）
 *     - Daemon 實際背景化（nohup / systemd）由使用者處理；Windows 可用
 *       `Start-Process -WindowStyle Hidden pwsh -ArgumentList ...`
 *   stop
 *     - 讀 pid.json → SIGTERM → 等 gracefulMs（5s 預設）→ SIGKILL
 *     - Windows 的 SIGTERM 等同 SIGKILL（Node/Bun 行為），仍能 graceful
 *       因為 daemon 在 main loop 結束前就會被 unref
 *   status
 *     - 讀 pid.json + liveness check，輸出 port/pid/uptime/state
 *   logs [-f]
 *     - 印 log 檔；`-f` 用 fs.watchFile 追蹤新行
 *   restart
 *     - stop → 等 pid.json 消失 → start（foreground）
 *
 * 輸出走 stdout / stderr，不依賴 ink UI（daemon 子命令可能在 CI / 腳本跑）。
 */
import { createReadStream, watchFile, unwatchFile } from 'fs'
import { stat } from 'fs/promises'
import { createInterface } from 'readline'
import { checkDaemonLiveness, readPidFile } from './pidFile.js'
import { getDaemonPaths } from './paths.js'
import { startDaemon, DaemonAlreadyRunningError } from './daemonMain.js'
import { handleClientMessage, sendHelloFrame } from './sessionBroker.js'
import { isAutostartEnabled, setAutostartEnabled } from './autostart.js'
import { createDaemonTurnMutex } from './daemonTurnMutex.js'
import { createProjectRegistry, projectIdFromCwd } from './projectRegistry.js'
import { createDefaultProjectRuntimeFactory } from './projectRuntimeFactory.js'
import {
  loadDiscordConfigSnapshot,
  getDiscordConfigSnapshot,
  seedDiscordConfigIfMissing,
  getDiscordBotToken,
} from '../discordConfig/index.js'
import {
  handleBindRequest,
  handleUnbindRequest,
  isDiscordBindRequest,
  isDiscordUnbindRequest,
} from './discordBindRpc.js'
import {
  handleAdminRequest,
  isDiscordAdminRequest,
} from './discordAdminRpc.js'
import {
  handleCronMutation,
  isCronMutationRequest,
} from './cronMutationRpc.js'
import {
  handleMemoryMutation,
  isMemoryMutationRequest,
} from './memoryMutationRpc.js'
import { isVisionEnabled } from '../llamacppConfig/loader.js'
import type { ClientInfo } from '../server/clientRegistry.js'

export const DEFAULT_STOP_GRACEFUL_MS = 5_000
export const DEFAULT_STOP_POLL_INTERVAL_MS = 100

export interface DaemonCliContext {
  baseDir?: string
  /** my-agent 版本字串（從 main.tsx 傳入 MACRO.VERSION） */
  agentVersion: string
  /** 測試可替換 stdout/stderr */
  stdout?: (msg: string) => void
  stderr?: (msg: string) => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h${rm}m`
}

export interface DaemonStartOptions {
  port?: number
  host?: string
  /** 阻塞直到 daemon 停止；預設 true。測試設 false 讓 handle 回傳。 */
  blockUntilStopped?: boolean
  /**
   * 啟動時 bootstrap QueryEngine context + sessionBroker，讓 WS client 真能跑 LLM。
   * 預設 false（保持 M-DAEMON-1~3 時行為），實際 daemon start CLI 會傳 true。
   * 測試可關掉避免拉 MCP / tools 的重負載。
   */
  enableQueryEngine?: boolean
  /** bootstrap context 的 cwd；預設 process.cwd()。 */
  cwd?: string
}

/**
 * 啟動 daemon（foreground）。預設阻塞直到收到 SIGINT/SIGTERM；
 * 測試可把 blockUntilStopped:false，此時回傳 handle 以便主動 stop。
 */
export async function runDaemonStart(
  ctx: DaemonCliContext,
  opts: DaemonStartOptions = {},
): Promise<import('./daemonMain.js').DaemonHandle> {
  const out = ctx.stdout ?? ((m: string) => process.stdout.write(m))
  const err = ctx.stderr ?? ((m: string) => process.stderr.write(m))
  try {
    // Two-phase wiring：broker 需要 server handle 才能廣播，但 server 啟動時就要
    // 綁 onMessage 才能接第一條 frame。用可變 ref 讓 startDaemon 的 onMessage
    // 只是 forwarder；broker 建好再把 handler 覆蓋掉。
    let onMessage: (c: ClientInfo, m: unknown) => void = () => {}
    let onConnect: (c: ClientInfo) => void = () => {}
    let onDisconnect: (c: ClientInfo) => void = () => {}
    const handle = await startDaemon({
      baseDir: ctx.baseDir,
      agentVersion: ctx.agentVersion,
      port: opts.port,
      host: opts.host,
      onClientMessage: (c, m) => onMessage(c, m),
      onClientConnect: c => onConnect(c),
      onClientDisconnect: c => onDisconnect(c),
    })

    // M-DISCORD-1.4：QueryEngine 改透過 ProjectRegistry + 全域 turn mutex。
    // 啟動時 auto-load 一個 default project（preserves 既有 single-project 行為）；
    // 未來（M-DISCORD-2）REPL thin-client handshake 帶 cwd 時由 registry 動態
    // load；Discord gateway（M-DISCORD-3）也會呼 registry.loadProject。
    let disposeRegistry: (() => Promise<void>) | null = null
    if (opts.enableQueryEngine && handle.server) {
      const cwd = opts.cwd ?? process.cwd()
      const baseCwd = process.cwd()
      const mutex = createDaemonTurnMutex()
      const factory = createDefaultProjectRuntimeFactory({
        server: handle.server,
        mutex,
        baseCwd,
      })
      const registry = createProjectRegistry({
        factory,
        onLoad: id =>
          void handle.logger.info('project loaded', { projectId: id }),
        onUnload: (id, reason) =>
          void handle.logger.info('project unloaded', {
            projectId: id,
            reason,
          }),
      })

      // Auto-load the starting cwd as the default project.
      const defaultRuntime = await registry.loadProject(cwd)

      // M-DISCORD-2：client 連線時如果帶 cwd，onConnect 會嘗試 resolve 對應
      // runtime；成功 → setClientProjectId；失敗 → 送 attachRejected + 在此 set
      // 記錄不派訊息。此 map 記錄所有被拒的 clientId。
      const rejectedClients = new Set<string>()
      // M-CWD-FIX：loadProject 異步期間暫存 client，避免 input 被 fallback 到 defaultRuntime。
      const pendingClients = new Map<string, string>()
      onMessage = (c, m): void => {
        if (rejectedClients.has(c.id)) {
          // 被拒的 client 送 input 一律忽略；REPL 已 fallback standalone，不該還在送。
          return
        }
        if (pendingClients.has(c.id)) {
          // Project 正在載入中，通知 REPL 不要送 input。
          handle.server!.send(c.id, {
            type: 'projectLoading',
            cwd: pendingClients.get(c.id),
          })
          return
        }
        // M-DISCORD-AUTOBIND：/discord-bind RPC dispatch — 不屬於任何 project runtime。
        if (isDiscordBindRequest(m)) {
          const req = m
          void (async () => {
            const res = await handleBindRequest(req, {
              getClient: () => discordClientRef,
              getConfig: () => getDiscordConfigSnapshot(),
            })
            handle.server!.send(c.id, res)
          })()
          return
        }
        if (isDiscordUnbindRequest(m)) {
          const req = m
          void (async () => {
            const res = await handleUnbindRequest(req, {
              getClient: () => discordClientRef,
              getConfig: () => getDiscordConfigSnapshot(),
            })
            handle.server!.send(c.id, res)
          })()
          return
        }
        // M-DISCORD-ADMIN：/discord-whitelist-add|remove /discord-invite /discord-guilds RPC
        if (isDiscordAdminRequest(m)) {
          const req = m
          void (async () => {
            const res = await handleAdminRequest(req, {
              getClient: () => discordClientRef,
              getConfig: () => getDiscordConfigSnapshot(),
            })
            handle.server!.send(c.id, res)
          })()
          return
        }
        // B1：cron mutation RPC — 走當前 client 綁定的 project runtime（如果
        // client 沒帶 cwd 則 fallback default runtime）。寫入後 broadcast 給
        // 所有同 project 的 client 刷新 UI。
        if (isCronMutationRequest(m)) {
          const req = m
          const runtime = c.projectId
            ? (registry.getProject(c.projectId) ?? defaultRuntime)
            : defaultRuntime
          void (async () => {
            const res = await handleCronMutation(req, {
              projectRoot: runtime.cwd,
              projectId: runtime.projectId,
            })
            handle.server!.send(c.id, res)
            if (res.ok) {
              try {
                handle.server!.broadcast(
                  {
                    type: 'cron.tasksChanged',
                    projectId: runtime.projectId,
                  },
                  x => x.projectId === runtime.projectId,
                )
              } catch {
                // best-effort
              }
            }
          })()
          return
        }
        // M-MEMTUI Phase 3：memory mutation RPC — mirror cron pattern。
        // 寫入後 broadcast `memory.itemsChanged` 給同 project 所有 client。
        if (isMemoryMutationRequest(m)) {
          const req = m
          const runtime = c.projectId
            ? (registry.getProject(c.projectId) ?? defaultRuntime)
            : defaultRuntime
          void (async () => {
            const res = await handleMemoryMutation(req, {
              projectRoot: runtime.cwd,
              projectId: runtime.projectId,
            })
            handle.server!.send(c.id, res)
            if (res.ok) {
              try {
                handle.server!.broadcast(
                  {
                    type: 'memory.itemsChanged',
                    projectId: runtime.projectId,
                  },
                  x => x.projectId === runtime.projectId,
                )
              } catch {
                // best-effort
              }
            }
          })()
          return
        }
        // /daemon attach|detach 用的 daemon-wide status 查詢（不屬於任何 project runtime）。
        if (
          m &&
          typeof m === 'object' &&
          (m as { type?: string }).type === 'queryDaemonStatus'
        ) {
          const req = m as { type: string; requestId?: unknown }
          const replCount = handle.server!.registry
            .list()
            .filter(x => x.source === 'repl').length
          handle.server!.send(c.id, {
            type: 'daemonStatus',
            requestId: String(req.requestId ?? ''),
            replCount,
            discordEnabled: discordActive,
          })
          return
        }
        // Route to the client's project runtime. projectId 由 onConnect resolve；
        // 沒 projectId 且沒 cwd 時 fallback 到 default runtime（backward compat —
        // M-DAEMON 階段的 client 不帶 cwd 也能用）。
        const runtime = c.projectId
          ? (registry.getProject(c.projectId) ?? defaultRuntime)
          : defaultRuntime
        // permissionResponse 命中就 route 給該 runtime 的 router。
        if (runtime.permissionRouter.handleResponse(c.id, m)) return
        // M-CRON-W3-8a：cronCreateWizardResult 走 wizard router（singleton map）。
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const wizardMod = require('./cronCreateWizardRouter.js') as typeof import('./cronCreateWizardRouter.js')
          const wr = wizardMod.getActiveCronWizardRouter(runtime.projectId)
          if (wr && wr.handleResponse(c.id, m)) return
        }
        // permissionContextSync（M-DAEMON-PERMS-B）同步 mode → 當前 runtime 的
        // toolPermissionContext.mode。
        if (
          m &&
          typeof m === 'object' &&
          (m as { type?: string }).type === 'permissionContextSync'
        ) {
          const sync = m as { type: string; mode?: string }
          if (typeof sync.mode === 'string') {
            const mode = sync.mode as import('../types/permissions.js').PermissionMode
            runtime.context.setAppState(prev =>
              prev.toolPermissionContext.mode === mode
                ? prev
                : {
                    ...prev,
                    toolPermissionContext: {
                      ...prev.toolPermissionContext,
                      mode,
                    },
                  },
            )
            void handle.logger.info('permission mode synced from client', {
              clientId: c.id,
              projectId: runtime.projectId,
              mode,
            })
          }
          return
        }
        runtime.touch()
        handleClientMessage(runtime.broker, c, m, (errMsg, raw) => {
          void handle.logger.warn('broker protocol error', {
            err: errMsg,
            raw,
            projectId: runtime.projectId,
          })
        })
      }
      onConnect = (c): void => {
        // 解析 client 的 cwd → projectId。
        //   - c.cwd 給了：registry 查找；有 → attach，無 → auto-load 再 attach
        //   - c.cwd 沒給：fallback 到 default runtime（backward compat）
        const attachRuntime = (runtime: typeof defaultRuntime): void => {
          handle.server!.registry.setClientProjectId(c.id, runtime.projectId)
          if (c.source === 'repl') runtime.attachRepl(c.id)
          runtime.touch()
          sendHelloFrame(runtime.broker, handle.server!, c.id)
        }
        if (c.cwd) {
          const found = registry.getProjectByCwd(c.cwd)
          if (found) {
            attachRuntime(found)
            return
          }
          // Project 未載入 → lazy-load（與 Discord 路徑一致）
          // M-CWD-FIX：標記 pending 防止 loadProject 期間 input 被 fallback 到 defaultRuntime。
          pendingClients.set(c.id, c.cwd)
          void handle.logger.info('auto-loading project for REPL client', {
            clientId: c.id,
            cwd: c.cwd,
          })
          registry.loadProject(c.cwd).then(
            (loaded) => {
              pendingClients.delete(c.id)
              attachRuntime(loaded)
            },
            (err) => {
              pendingClients.delete(c.id)
              rejectedClients.add(c.id)
              handle.server!.send(c.id, {
                type: 'attachRejected',
                reason: 'projectLoadFailed',
                cwd: c.cwd,
                hint: `failed to load project at ${c.cwd}: ${err instanceof Error ? err.message : String(err)}`,
              })
              void handle.logger.warn('auto-load project failed', {
                clientId: c.id,
                cwd: c.cwd,
                err: err instanceof Error ? err.message : String(err),
              })
            },
          )
        } else {
          attachRuntime(defaultRuntime)
        }
      }
      onDisconnect = (c): void => {
        rejectedClients.delete(c.id)
        pendingClients.delete(c.id)
        if (c.projectId && c.source === 'repl') {
          const runtime = registry.getProject(c.projectId)
          runtime?.detachRepl(c.id)
        }
      }

      // M-DISCORD-3c：Discord gateway 在 registry 就位後啟動（enabled=true + token set）。
      let disposeDiscord: (() => Promise<void>) | null = null
      // Daemon-wide discord active flag — /daemon detach 的 shutdown 判定會讀它。
      let discordActive = false
      // M-DISCORD-AUTOBIND：/discord-bind RPC 要用的 Discord Client 參考（gateway 啟動後填入）
      let discordClientRef: import('discord.js').Client | null = null
      try {
        await seedDiscordConfigIfMissing()
        const discordCfg = await loadDiscordConfigSnapshot()
        const discordToken = getDiscordBotToken() // env > config.botToken
        if (discordCfg.enabled && discordToken) {
          const { startDiscordGateway } = await import('../discord/gateway.js')
          const dg = await startDiscordGateway({
            config: discordCfg,
            token: discordToken,
            registry,
            visionEnabled: isVisionEnabled(),
            log: handle.logger,
            // M-DISCORD-4：Discord /mode → broadcast permissionModeChanged 到
            // 同 project 所有 attached REPL client（REPL 會 apply 本機 mode）。
            broadcastPermissionMode: (projectId, mode) => {
              if (!handle.server) return
              handle.server.broadcast(
                {
                  type: 'permissionModeChanged',
                  projectId,
                  mode,
                },
                c => c.projectId === projectId,
              )
            },
            broadcastDiscordInbound: (projectId, payload) => {
              if (!handle.server) return
              handle.server.broadcast(
                {
                  type: 'discordInboundMessage',
                  projectId,
                  ...payload,
                },
                c => c.projectId === projectId,
              )
            },
            broadcastDiscordTurn: (projectId, payload) => {
              if (!handle.server) return
              handle.server.broadcast(
                {
                  type: 'discordTurnEvent',
                  projectId,
                  ...payload,
                },
                c => c.projectId === projectId,
              )
            },
          })
          disposeDiscord = dg.dispose
          discordClientRef = dg.client.raw
          discordActive = true
          const tokenSrc = process.env.DISCORD_BOT_TOKEN ? 'env' : 'config'
          out(`  discord:     enabled (bot connected, token from ${tokenSrc})\n`)
        } else if (discordCfg.enabled && !discordToken) {
          void handle.logger.warn(
            'discord enabled in config but no token (neither DISCORD_BOT_TOKEN env nor discord.json botToken); skipping',
          )
          out(
            `  discord:     config enabled but no token — set DISCORD_BOT_TOKEN or discord.json "botToken"\n`,
          )
        }
      } catch (e) {
        void handle.logger.error('failed to start discord gateway', {
          err: e instanceof Error ? e.message : String(e),
        })
        out(
          `  discord:     startup failed (${e instanceof Error ? e.message : String(e)})\n`,
        )
      }

      disposeRegistry = async (): Promise<void> => {
        if (disposeDiscord) {
          try {
            await disposeDiscord()
          } catch {
            // ignore
          }
        }
        await registry.dispose()
      }
      out(
        `  queryEngine: enabled (default project ${defaultRuntime.projectId.slice(0, 20)}…, session ${defaultRuntime.sessionHandle.sessionId.slice(0, 8)}…)\n`,
      )
      if (defaultRuntime.cron.scheduler) {
        out(`  cron:        enabled\n`)
      } else {
        // Startup print mirrors the daemon-log ERROR already emitted by
        // cronWiring. Showing it here too helps a user running
        // `./cli daemon start` in foreground notice immediately instead of
        // discovering missing fires hours later.
        out(
          `  cron:        DISABLED (AGENT_TRIGGERS flag off — tasks on disk will NOT fire; see daemon.log)\n`,
        )
      }
    }

    out(
      `my-agent daemon started
  pid:   ${handle.pidData.pid}
  host:  ${handle.server?.host ?? '(no server)'}
  port:  ${handle.server?.port ?? 0}
  token: ${handle.token.slice(0, 8)}… (full at ${handle.paths.tokenPath})
  log:   ${handle.paths.logPath}
  pid:   ${handle.paths.pidPath}

Send SIGINT (Ctrl+C) or run \`my-agent daemon stop\` to shut down.
`,
    )

    // 包一層 stop：先釋放 registry（unload 所有 runtime）再 stop server。
    if (disposeRegistry) {
      const origStop = handle.stop
      ;(handle as { stop: typeof origStop }).stop = async (reason): Promise<void> => {
        try {
          await disposeRegistry!()
        } catch {
          // 盡力清理
        }
        return origStop(reason)
      }
    }

    if (opts.blockUntilStopped !== false) {
      await handle.stopped
      // SIGTERM 觸發 daemonMain 的原始 stop()（閉包），不會走 wrapped stop，
      // 所以 disposeRegistry 不會被呼叫。在此補清理 + 強制退出。
      if (disposeRegistry) {
        try {
          await disposeRegistry()
        } catch {
          // 盡力清理
        }
      }
      process.exit(0)
    }
    return handle
  } catch (e) {
    if (e instanceof DaemonAlreadyRunningError) {
      err(
        `daemon already running (pid ${e.existing.pid}, port ${e.existing.port}).\n` +
          `Use \`my-agent daemon stop\` first, or \`my-agent daemon status\`.\n`,
      )
    } else {
      err(`daemon start failed: ${String(e)}\n`)
    }
    throw e
  }
}

export interface DaemonStopOptions {
  gracefulMs?: number
  pollIntervalMs?: number
}

export interface DaemonStopResult {
  found: boolean
  stopped: boolean
  forced: boolean
  pid?: number
}

/**
 * 停止執行中 daemon。SIGTERM → 等 gracefulMs → SIGKILL if still alive。
 * 回傳結果描述；不丟錯（即使 daemon 不存在也算 "found: false"）。
 */
export async function runDaemonStop(
  ctx: DaemonCliContext,
  opts: DaemonStopOptions = {},
): Promise<DaemonStopResult> {
  const out = ctx.stdout ?? ((m: string) => process.stdout.write(m))
  const liveness = await checkDaemonLiveness(ctx.baseDir)
  if (!liveness.data) {
    out('no daemon running (no pid.json found)\n')
    return { found: false, stopped: false, forced: false }
  }
  if (liveness.stale) {
    out(
      `stale pid.json found (reason: ${liveness.reason}); nothing to stop\n`,
    )
    return {
      found: true,
      stopped: false,
      forced: false,
      pid: liveness.data.pid,
    }
  }
  const pid = liveness.data.pid
  const gracefulMs = opts.gracefulMs ?? DEFAULT_STOP_GRACEFUL_MS
  const pollMs = opts.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS

  out(`stopping daemon pid=${pid}...\n`)

  // Bun 編譯 binary 的 SIGTERM signal handler 不可靠（macOS 實測不觸發），
  // 直接 SIGKILL 確保 daemon 停止，再由此端清理 pid.json。
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    out(`SIGKILL failed: ${String(e)}\n`)
    return { found: true, stopped: false, forced: false, pid }
  }
  // 再等一小段清理
  await new Promise(r => setTimeout(r, pollMs * 3))
  let final = await readPidFile(ctx.baseDir)
  // Windows 上 SIGKILL（TerminateProcess）繞過 daemon 的 cleanup，pid.json
  // 會成為 orphan；process 真的死了就由 stop 幫忙清。確認 pid 已死再刪。
  if (final !== null && final.pid === pid) {
    const { isPidAlive } = await import('./pidFile.js')
    if (!isPidAlive(pid)) {
      out(`force-killed daemon pid=${pid}; cleaning orphan pid.json\n`)
      try {
        const { deletePidFile } = await import('./pidFile.js')
        await deletePidFile(ctx.baseDir)
        final = null
      } catch {
        // 最後還是清不掉就讓呼叫方處理
      }
    }
  }
  return {
    found: true,
    stopped: final === null,
    forced: true,
    pid,
  }
}

export interface DaemonStatus {
  running: boolean
  reason?: 'missing' | 'dead-pid' | 'no-heartbeat'
  pid?: number
  port?: number
  host?: string
  startedAt?: number
  lastHeartbeat?: number
  uptimeMs?: number
  heartbeatAgeMs?: number
  agentVersion?: string
}

export async function runDaemonStatus(
  ctx: DaemonCliContext,
  now: number = Date.now(),
): Promise<DaemonStatus> {
  const liveness = await checkDaemonLiveness(ctx.baseDir, { now })
  const out = ctx.stdout ?? ((m: string) => process.stdout.write(m))
  if (!liveness.data) {
    out('daemon: not running\n')
    return { running: false, reason: liveness.reason }
  }
  const d = liveness.data
  const status: DaemonStatus = {
    running: !liveness.stale,
    reason: liveness.reason,
    pid: d.pid,
    port: d.port,
    startedAt: d.startedAt,
    lastHeartbeat: d.lastHeartbeat,
    uptimeMs: now - d.startedAt,
    heartbeatAgeMs: now - d.lastHeartbeat,
    agentVersion: d.agentVersion,
  }
  out(
    `daemon: ${status.running ? 'running' : `stale (${liveness.reason})`}
  pid:           ${d.pid}
  port:          ${d.port}
  agentVersion:  ${d.agentVersion}
  startedAt:     ${new Date(d.startedAt).toISOString()}
  uptime:        ${formatDuration(status.uptimeMs!)}
  lastHeartbeat: ${new Date(d.lastHeartbeat).toISOString()} (${formatDuration(status.heartbeatAgeMs!)} ago)
`,
  )
  return status
}

export interface DaemonLogsOptions {
  /** Tail 模式（相當於 `tail -f`）；預設 false = 印完整檔就結束 */
  follow?: boolean
  /** 追蹤模式的檢查間隔（預設 500ms） */
  pollIntervalMs?: number
  /** 已知尾端 offset；預設 0（讀整個檔） */
  startOffset?: number
  /** 測試用：停止 follow 的 AbortSignal */
  signal?: AbortSignal
}

/**
 * 印出 daemon.log；`follow:true` 持續追蹤新行直到收到 abort signal。
 */
export async function runDaemonLogs(
  ctx: DaemonCliContext,
  opts: DaemonLogsOptions = {},
): Promise<void> {
  const { logPath } = getDaemonPaths(ctx.baseDir)
  const out = ctx.stdout ?? ((m: string) => process.stdout.write(m))
  const err = ctx.stderr ?? ((m: string) => process.stderr.write(m))

  let offset = opts.startOffset ?? 0

  const printFromOffset = async (): Promise<number> => {
    try {
      const s = await stat(logPath)
      if (s.size <= offset) return offset
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(logPath, {
          start: offset,
          end: s.size - 1,
          encoding: 'utf-8',
        })
        const rl = createInterface({ input: stream })
        rl.on('line', line => out(line + '\n'))
        rl.on('close', resolve)
        rl.on('error', reject)
      })
      return s.size
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        err(`log file not found: ${logPath}\n`)
        return offset
      }
      throw e
    }
  }

  offset = await printFromOffset()
  if (!opts.follow) return

  const pollMs = opts.pollIntervalMs ?? 500
  const signal = opts.signal
  let stopped = false
  const onAbort = (): void => {
    stopped = true
  }
  signal?.addEventListener('abort', onAbort)

  try {
    while (!stopped && !signal?.aborted) {
      await new Promise(r => setTimeout(r, pollMs))
      offset = await printFromOffset()
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  // watchFile 清理（Windows 有些路徑會殘留 listener）
  try {
    unwatchFile(logPath)
  } catch {
    // ignore
  }
}

/**
 * Restart = stop + start。foreground 模式下會先 stop 再 start，阻塞。
 */
export async function runDaemonRestart(
  ctx: DaemonCliContext,
  opts: DaemonStartOptions = {},
): Promise<import('./daemonMain.js').DaemonHandle> {
  await runDaemonStop(ctx)
  // 稍等 port 回收
  await new Promise(r => setTimeout(r, 200))
  return runDaemonStart(ctx, opts)
}

/**
 * `my-agent daemon autostart on | off | status` 實作。
 * 寫入 `~/.my-agent/.claude.json` 的 `daemonAutoStart` key。REPL 啟動時
 * 讀這個決定要不要 spawn background daemon。
 */
export type AutostartAction = 'on' | 'off' | 'status'
export interface AutostartResult {
  enabled: boolean
  changed: boolean
}
export async function runDaemonAutostart(
  ctx: DaemonCliContext,
  action: AutostartAction,
): Promise<AutostartResult> {
  const out = ctx.stdout ?? ((m: string) => process.stdout.write(m))
  const prev = isAutostartEnabled()
  if (action === 'status') {
    out(`daemon autostart: ${prev ? 'on' : 'off'}\n`)
    return { enabled: prev, changed: false }
  }
  const next = action === 'on'
  if (next === prev) {
    out(`daemon autostart already ${next ? 'on' : 'off'}\n`)
    return { enabled: next, changed: false }
  }
  setAutostartEnabled(next)
  out(`daemon autostart: ${prev ? 'on' : 'off'} → ${next ? 'on' : 'off'}\n`)
  return { enabled: next, changed: true }
}
