/**
 * Daemon pid.json 讀寫 + heartbeat + 存活判定。
 *
 * Schema：
 *   {
 *     "version": 1,
 *     "pid": <process.pid>,
 *     "port": <WS 監聽 port>,
 *     "startedAt": <epoch ms>,
 *     "lastHeartbeat": <epoch ms>,
 *     "agentVersion": <my-agent 版本字串>
 *   }
 *
 * Stale 判定（REPL attach 前、daemon 自己啟動前都會用到）：
 *   - 檔案不存在 → 無 daemon
 *   - pid 已死（kill(pid, 0) 拋 ESRCH） → stale
 *   - now - lastHeartbeat > maxStaleMs（預設 30s） → stale
 *
 * 讀寫都 graceful：壞 JSON / 缺欄位一律當作「無 daemon」回 null，由呼叫端決定清理。
 */
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { getDaemonPaths } from './paths.js'

export const PID_SCHEMA_VERSION = 1
export const DEFAULT_MAX_STALE_MS = 30_000

export interface PidFileData {
  version: number
  pid: number
  port: number
  startedAt: number
  lastHeartbeat: number
  agentVersion: string
}

function isPidFileData(value: unknown): value is PidFileData {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.version === 'number' &&
    typeof v.pid === 'number' &&
    typeof v.port === 'number' &&
    typeof v.startedAt === 'number' &&
    typeof v.lastHeartbeat === 'number' &&
    typeof v.agentVersion === 'string'
  )
}

export async function readPidFile(
  baseDir?: string,
): Promise<PidFileData | null> {
  const { pidPath } = getDaemonPaths(baseDir)
  try {
    const raw = await readFile(pidPath, 'utf-8')
    const parsed: unknown = jsonParse(raw)
    if (!isPidFileData(parsed)) {
      logForDebugging(`[daemon:pid] malformed pid file at ${pidPath}`, {
        level: 'warn',
      })
      return null
    }
    if (parsed.version !== PID_SCHEMA_VERSION) {
      logForDebugging(
        `[daemon:pid] schema version mismatch: got ${parsed.version}, want ${PID_SCHEMA_VERSION}`,
        { level: 'warn' },
      )
      return null
    }
    return parsed
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return null
    logForDebugging(`[daemon:pid] read failed: ${err}`, { level: 'warn' })
    return null
  }
}

export async function writePidFile(
  data: PidFileData,
  baseDir?: string,
): Promise<void> {
  const { pidPath } = getDaemonPaths(baseDir)
  await mkdir(dirname(pidPath), { recursive: true })
  await writeFile(pidPath, jsonStringify(data), { encoding: 'utf-8' })
}

export async function updateHeartbeat(
  baseDir?: string,
  now: number = Date.now(),
): Promise<PidFileData | null> {
  const existing = await readPidFile(baseDir)
  if (!existing) return null
  const updated: PidFileData = { ...existing, lastHeartbeat: now }
  await writePidFile(updated, baseDir)
  return updated
}

export async function deletePidFile(baseDir?: string): Promise<void> {
  const { pidPath } = getDaemonPaths(baseDir)
  try {
    await unlink(pidPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      logForDebugging(`[daemon:pid] delete failed: ${err}`, { level: 'warn' })
    }
  }
}

/**
 * 探測 pid 是否存活。`process.kill(pid, 0)` 不實際送訊號，只檢查 pid 存在性。
 * 錯誤碼：ESRCH = 不存在；EPERM = 存在但無權訪問（視為存活）。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return true
    return false
  }
}

export interface StaleResult {
  stale: boolean
  reason?: 'missing' | 'dead-pid' | 'no-heartbeat'
  data?: PidFileData
}

/**
 * 判定 daemon 是否可用：檔案存在 + pid 活著 + heartbeat 新鮮。
 * 呼叫端收到 stale 時通常要清理 pid.json 後續自啟 daemon。
 */
export async function checkDaemonLiveness(
  baseDir?: string,
  options?: { maxStaleMs?: number; now?: number },
): Promise<StaleResult> {
  const data = await readPidFile(baseDir)
  if (!data) return { stale: true, reason: 'missing' }

  if (!isPidAlive(data.pid)) {
    return { stale: true, reason: 'dead-pid', data }
  }

  const maxStaleMs = options?.maxStaleMs ?? DEFAULT_MAX_STALE_MS
  const now = options?.now ?? Date.now()
  if (now - data.lastHeartbeat > maxStaleMs) {
    return { stale: true, reason: 'no-heartbeat', data }
  }

  return { stale: false, data }
}
