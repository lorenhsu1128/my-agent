/**
 * Daemon 檔案路徑解析。
 *
 * 固定 3 個檔案：
 *   - pid.json  : 執行中 daemon 的後設資料（port/pid/heartbeat）
 *   - token     : WS 客戶端需帶的 bearer token（0600）
 *   - log       : JSON lines 結構化日誌
 *
 * 測試時傳入 `baseDir` 覆蓋 `~/.my-agent/`，避免踩到真實 daemon。
 */
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

export const DAEMON_PID_FILENAME = 'daemon.pid.json'
export const DAEMON_TOKEN_FILENAME = 'daemon.token'
export const DAEMON_LOG_FILENAME = 'daemon.log'

export interface DaemonPaths {
  baseDir: string
  pidPath: string
  tokenPath: string
  logPath: string
}

export function getDaemonPaths(baseDir?: string): DaemonPaths {
  const root = baseDir ?? getClaudeConfigHomeDir()
  return {
    baseDir: root,
    pidPath: join(root, DAEMON_PID_FILENAME),
    tokenPath: join(root, DAEMON_TOKEN_FILENAME),
    logPath: join(root, DAEMON_LOG_FILENAME),
  }
}
