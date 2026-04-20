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
import { bootstrapDaemonContext } from './sessionBootstrap.js'
import { createQueryEngineRunner } from './queryEngineRunner.js'
import { createSessionBroker, handleClientMessage, sendHelloFrame, type SessionBroker } from './sessionBroker.js'
import { beginDaemonSession } from './sessionWriter.js'
import { startDaemonCronWiring } from './cronWiring.js'
import { createPermissionRouter } from './permissionRouter.js'
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
    const handle = await startDaemon({
      baseDir: ctx.baseDir,
      agentVersion: ctx.agentVersion,
      port: opts.port,
      host: opts.host,
      onClientMessage: (c, m) => onMessage(c, m),
      onClientConnect: c => onConnect(c),
    })

    // QueryEngine wiring（可關掉給既有 daemon lifecycle 測試用）。
    let disposeBroker: (() => Promise<void>) | null = null
    if (opts.enableQueryEngine && handle.server) {
      const cwd = opts.cwd ?? process.cwd()
      const context = await bootstrapDaemonContext({ cwd })
      const sessionHandle = beginDaemonSession({ cwd })

      // M-DAEMON-7：Permission router — runner 的 canUseTool 交給它路由到 source client。
      // broker 還沒建；用 ref 讓 router 能動態查 current turn。
      const brokerRef: { current: SessionBroker | null } = { current: null }
      const permissionRouter = createPermissionRouter({
        server: handle.server,
        resolveSourceClientId: () =>
          brokerRef.current?.queue.currentInput?.clientId ?? null,
        resolveCurrentInputId: () =>
          brokerRef.current?.queue.currentInput?.id ?? null,
      })

      const runner = createQueryEngineRunner({
        context,
        canUseTool: permissionRouter.canUseTool,
      })
      const broker = createSessionBroker({
        server: handle.server,
        context,
        runner,
        sessionHandle,
      })
      brokerRef.current = broker
      onMessage = (c, m): void => {
        // M-DAEMON-7：先試 permissionResponse；命中就 route 給 router，否則交給 broker。
        if (permissionRouter.handleResponse(c.id, m)) return
        handleClientMessage(broker, c, m, (errMsg, raw) => {
          void handle.logger.warn('broker protocol error', {
            err: errMsg,
            raw,
          })
        })
      }
      onConnect = (c): void => sendHelloFrame(broker, handle.server!, c.id)
      const cronHandle = startDaemonCronWiring({ broker })
      disposeBroker = async (): Promise<void> => {
        cronHandle.stop()
        permissionRouter.cancelAll('daemon stopping')
        await broker.dispose()
        sessionHandle.dispose()
        await context.dispose()
      }
      out(
        `  queryEngine: enabled (session ${sessionHandle.sessionId.slice(0, 8)}…)\n`,
      )
      if (cronHandle.scheduler) {
        out(`  cron:        enabled\n`)
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

    // 包一層 stop：先釋放 broker 再 stop server。
    if (disposeBroker) {
      const origStop = handle.stop
      ;(handle as { stop: typeof origStop }).stop = async (reason): Promise<void> => {
        try {
          await disposeBroker!()
        } catch {
          // 盡力清理
        }
        return origStop(reason)
      }
    }

    if (opts.blockUntilStopped !== false) {
      await handle.stopped
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
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    out(`SIGTERM failed: ${String(e)}\n`)
    return { found: true, stopped: false, forced: false, pid }
  }

  const deadline = Date.now() + gracefulMs
  while (Date.now() < deadline) {
    const cur = await readPidFile(ctx.baseDir)
    if (!cur) {
      out(`daemon pid=${pid} stopped gracefully\n`)
      return { found: true, stopped: true, forced: false, pid }
    }
    await new Promise(r => setTimeout(r, pollMs))
  }

  // SIGKILL fallback
  out(`graceful stop timeout (${gracefulMs}ms), sending SIGKILL\n`)
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 可能已經在 TERM 後自己退了，race
  }
  // 再等一小段清理
  await new Promise(r => setTimeout(r, pollMs * 3))
  const final = await readPidFile(ctx.baseDir)
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
