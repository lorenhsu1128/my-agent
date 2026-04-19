/**
 * Daemon 結構化日誌（JSON lines → `~/.my-agent/daemon.log`）。
 *
 * 此模組僅負責寫檔；REPL 的 debug.ts 面向 stderr / ink UI，不適合 daemon
 * （daemon 背景跑沒 TTY）。
 *
 * 行格式：`{"ts":"<ISO>","level":"info","msg":"...","meta":{...}}\n`
 * 無輪替；由外層 ops 或 `my-agent daemon logs` 的 logrotate 處理（M-DAEMON-3）。
 */
import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { jsonStringify } from '../utils/slowOperations.js'
import { getDaemonPaths } from './paths.js'

export type DaemonLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DaemonLogEntry {
  ts: string
  level: DaemonLogLevel
  msg: string
  meta?: Record<string, unknown>
}

export interface DaemonLogger {
  debug(msg: string, meta?: Record<string, unknown>): Promise<void>
  info(msg: string, meta?: Record<string, unknown>): Promise<void>
  warn(msg: string, meta?: Record<string, unknown>): Promise<void>
  error(msg: string, meta?: Record<string, unknown>): Promise<void>
  /** 對應 log 檔的絕對路徑（供測試 / `daemon logs` 指令讀取）。 */
  readonly path: string
}

async function writeLine(
  logPath: string,
  entry: DaemonLogEntry,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, jsonStringify(entry) + '\n', 'utf-8')
}

export function createDaemonLogger(baseDir?: string): DaemonLogger {
  const { logPath } = getDaemonPaths(baseDir)
  const writeAtLevel = (level: DaemonLogLevel) =>
    async (msg: string, meta?: Record<string, unknown>): Promise<void> => {
      const entry: DaemonLogEntry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...(meta ? { meta } : {}),
      }
      try {
        await writeLine(logPath, entry)
      } catch {
        // 日誌寫入失敗不能中斷 daemon 本身；靜默吞掉。
        // 若需 diagnose，daemon 的啟動預檢（M-DAEMON-3）會測試寫入權限。
      }
    }
  return {
    debug: writeAtLevel('debug'),
    info: writeAtLevel('info'),
    warn: writeAtLevel('warn'),
    error: writeAtLevel('error'),
    path: logPath,
  }
}
