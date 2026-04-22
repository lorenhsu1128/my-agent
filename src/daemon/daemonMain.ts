/**
 * Daemon 主迴圈（M-DAEMON-1 最小版本）。
 *
 * 本階段只做：
 *   1. 檢查是否已有 live daemon（有 → 拒絕啟動）
 *   2. 生成 / 讀取 token
 *   3. 寫 pid.json
 *   4. 每 N 毫秒更新 heartbeat
 *   5. 註冊 SIGTERM / SIGINT / SIGBREAK 觸發 graceful stop
 *   6. stop 時清理 pid.json（token 保留，下次啟動沿用）
 *
 * 尚未接：WS server（M-DAEMON-2）、QueryEngine（M-DAEMON-4）、
 *         Input queue（M-DAEMON-5）、cron 搬遷（M-DAEMON-4.5）。
 *
 * 測試使用方式：
 *   const handle = await startDaemon({ agentVersion: 'test', baseDir })
 *   // ... 驗證 pid.json ...
 *   await handle.stop()
 */
import { checkDaemonLiveness, deletePidFile, updateHeartbeat, writePidFile } from './pidFile.js'
import type { PidFileData } from './pidFile.js'
import { ensureToken } from './authToken.js'
import { createDaemonLogger } from './daemonLog.js'
import type { DaemonLogger } from './daemonLog.js'
import { getDaemonPaths } from './paths.js'
import type { DaemonPaths } from './paths.js'
import { PID_SCHEMA_VERSION } from './pidFile.js'
import {
  startDirectConnectServer,
  type DirectConnectServerHandle,
} from '../server/directConnectServer.js'
import type { ClientInfo } from '../server/clientRegistry.js'

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
export const DEFAULT_STOP_GRACE_MS = 5_000

export interface DaemonOptions {
  /** 覆寫 `~/.my-agent/` 根目錄（測試用）。 */
  baseDir?: string
  /** my-agent 版本字串（來自呼叫端的 `MACRO.VERSION`）。 */
  agentVersion: string
  /** WS 監聽 port；0（預設）= OS 指派。 */
  port?: number
  /** WS 監聽 host；預設 127.0.0.1（loopback only）。 */
  host?: string
  /** Heartbeat 更新頻率；預設 10s。 */
  heartbeatIntervalMs?: number
  /** 是否註冊 process signal（預設 true；測試可關掉避免干擾） */
  registerSignalHandlers?: boolean
  /**
   * 是否啟動 WS server。預設 true。
   * 測試只驗 pid/token 機制時可設 false，避免開 port。
   */
  enableServer?: boolean
  /** 收到 client message 時的 callback（M-DAEMON-4+ sessionBroker 接） */
  onClientMessage?: (client: ClientInfo, msg: unknown) => void
  onClientConnect?: (client: ClientInfo) => void
  onClientDisconnect?: (client: ClientInfo) => void
}

export type DaemonStopReason =
  | 'explicit'
  | 'signal-SIGINT'
  | 'signal-SIGTERM'
  | 'signal-SIGBREAK'

export interface DaemonHandle {
  readonly paths: DaemonPaths
  readonly token: string
  readonly pidData: PidFileData
  readonly logger: DaemonLogger
  /** WS server（當 `enableServer !== false` 時有值）。 */
  readonly server: DirectConnectServerHandle | null
  /** 主動停止 daemon。冪等。 */
  stop(reason?: DaemonStopReason): Promise<void>
  /** Promise，resolve 時代表 daemon 已停止並清理完畢。 */
  readonly stopped: Promise<void>
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly existing: PidFileData) {
    super(
      `daemon already running: pid=${existing.pid} port=${existing.port} started=${new Date(existing.startedAt).toISOString()}`,
    )
    this.name = 'DaemonAlreadyRunningError'
  }
}

export async function startDaemon(
  opts: DaemonOptions,
): Promise<DaemonHandle> {
  const baseDir = opts.baseDir
  const agentVersion = opts.agentVersion
  const requestedPort = opts.port ?? 0
  const host = opts.host ?? '127.0.0.1'
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const registerSignals = opts.registerSignalHandlers ?? true
  const enableServer = opts.enableServer ?? true

  const paths = getDaemonPaths(baseDir)
  const logger = createDaemonLogger(baseDir)

  // 1. 檢查既有 daemon
  const liveness = await checkDaemonLiveness(baseDir)
  if (!liveness.stale) {
    throw new DaemonAlreadyRunningError(liveness.data!)
  }
  if (liveness.data) {
    await logger.warn('stale pid.json, taking over', {
      reason: liveness.reason,
      prev: liveness.data,
    })
    await deletePidFile(baseDir)
  }

  // 2. Token（已有就沿用，沒有就生成）
  const token = await ensureToken(baseDir)

  // 3. 啟動 WS server（取得實際 port 再寫 pid.json）
  let server: DirectConnectServerHandle | null = null
  if (enableServer) {
    server = await startDirectConnectServer({
      token,
      port: requestedPort,
      host,
      logger,
      onMessage: opts.onClientMessage,
      onClientConnect: opts.onClientConnect,
      onClientDisconnect: opts.onClientDisconnect,
    })
  }
  const actualPort = server?.port ?? requestedPort

  // 4. 寫 pid.json
  const startedAt = Date.now()
  const pidData: PidFileData = {
    version: PID_SCHEMA_VERSION,
    pid: process.pid,
    port: actualPort,
    startedAt,
    lastHeartbeat: startedAt,
    agentVersion,
  }
  await writePidFile(pidData, baseDir)
  await logger.info('daemon started', {
    pid: pidData.pid,
    port: actualPort,
    host,
    agentVersion,
    pidPath: paths.pidPath,
    serverEnabled: enableServer,
  })

  // 5. Heartbeat
  let stopping = false
  let resolveStopped!: () => void
  const stopped = new Promise<void>(r => {
    resolveStopped = r
  })

  const heartbeatTimer = setInterval(() => {
    updateHeartbeat(baseDir).catch(err => {
      void logger.warn('heartbeat update failed', { err: String(err) })
    })
  }, heartbeatIntervalMs)

  const stop = async (
    reason: DaemonStopReason = 'explicit',
  ): Promise<void> => {
    if (stopping) return stopped
    stopping = true
    clearInterval(heartbeatTimer)
    if (registerSignals) {
      unregister()
    }
    await logger.info('daemon stopping', { reason })
    if (server) {
      await server.stop()
    }
    await deletePidFile(baseDir)
    await logger.info('daemon stopped', { reason })
    resolveStopped()
  }

  // 5. Signal handlers — stop + 強制退出兜底（避免 server.stop() hang 住）
  const signalStop = (reason: DaemonStopReason): void => {
    void stop(reason).finally(() => process.exit(0))
    // 若 stop() 本身 hang（WS close 卡住等），3 秒後強制退出
    setTimeout(() => process.exit(0), 3_000).unref()
  }
  const sigintHandler = (): void => signalStop('signal-SIGINT')
  const sigtermHandler = (): void => signalStop('signal-SIGTERM')
  const sigbreakHandler = (): void => signalStop('signal-SIGBREAK')

  const unregister = (): void => {
    process.off('SIGINT', sigintHandler)
    process.off('SIGTERM', sigtermHandler)
    // SIGBREAK 只在 Windows 存在；off() 對未註冊的事件名是 no-op
    process.off('SIGBREAK' as NodeJS.Signals, sigbreakHandler)
  }

  if (registerSignals) {
    process.on('SIGINT', sigintHandler)
    process.on('SIGTERM', sigtermHandler)
    process.on('SIGBREAK' as NodeJS.Signals, sigbreakHandler)
  }

  return {
    paths,
    token,
    pidData,
    logger,
    server,
    stop,
    stopped,
  }
}
