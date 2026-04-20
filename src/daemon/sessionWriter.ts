/**
 * M-DAEMON-4c：Session JSONL 獨占寫入入口。
 *
 * Daemon 每次啟動會 (1) regenerate 一個新的 sessionId、(2) 宣告該 sessionId
 * 對應 `.jsonl` 的獨占寫入權（透過 projectDir 下的 `.daemon.lock`）、
 * (3) 回傳 handle 讓 broker 記錄 session 基本資訊。
 *
 * 實際 `<sessionId>.jsonl` 的寫入是 `ask()` → QueryEngine 內部透過
 * `recordTranscript()` 走既有 `Project` singleton 的路徑（src/utils/sessionStorage.ts）。
 * 這裡**不重複實作** transcript 寫入 — 單一 source of truth 避免跟 Project
 * 的 pending queue / reAppendSessionMetadata 爭 race。
 *
 * Lockfile 的作用：防同一個 cwd 被兩個 daemon 實例誤啟用（理論上 pidfile
 * 已經擋過，但 cwd 層級的鎖多一道防呆，例如使用者在另一個 my-agent checkout
 * 啟另一個 daemon 但 MY_AGENT_CONFIG_HOME 指到同一處）。失敗視為致命錯誤。
 */
import { randomUUID } from 'crypto'
import {
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  writeSync,
  readFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { regenerateSessionId } from '../bootstrap/state.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { isPidAlive } from './pidFile.js'
import { logForDebugging } from '../utils/debug.js'

export interface DaemonSessionHandle {
  readonly sessionId: string
  readonly projectDir: string
  readonly transcriptPath: string
  readonly lockPath: string
  dispose(): void
}

export interface BeginDaemonSessionOptions {
  cwd: string
}

export function beginDaemonSession(
  opts: BeginDaemonSessionOptions,
): DaemonSessionHandle {
  const projectDir = getProjectDir(opts.cwd)
  try {
    mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  } catch {
    // 已存在 OK。
  }

  const lockPath = join(projectDir, '.daemon.lock')
  // `wx` 獨占建立；如果 EEXIST：讀 lock 內容看 pid 是否活著，死了就當 stale
  // 自動接管（同 pidfile 的 take-over 語意），活著才真的拒絕。
  let lockFd: number
  const tryOpen = (): number =>
    openSync(lockPath, 'wx', 0o600)
  try {
    lockFd = tryOpen()
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      throw new Error(
        `Failed to acquire daemon session lock at ${lockPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    // Stale detection：讀 lock 判斷 pid 是否活著
    let stale = true
    let existing: { pid?: unknown; startedAt?: unknown } | null = null
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
        pid?: unknown
        startedAt?: unknown
      }
      if (typeof existing.pid === 'number' && isPidAlive(existing.pid)) {
        stale = false
      }
    } catch {
      // 壞 JSON / 空檔都視為 stale
    }
    if (!stale) {
      throw new Error(
        `Daemon session lock held by live pid=${existing?.pid} at ${lockPath}. ` +
          `Another daemon is already running for this project.`,
      )
    }
    logForDebugging(
      `[daemon:lock] stale lock at ${lockPath} (pid=${existing?.pid ?? 'unknown'} dead), taking over`,
    )
    try {
      unlinkSync(lockPath)
    } catch (unlinkErr) {
      throw new Error(
        `Failed to remove stale daemon session lock at ${lockPath}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
      )
    }
    lockFd = tryOpen()
  }
  writeSync(
    lockFd,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n',
  )

  // 新 sessionId + cwd 對應 projectDir 註冊到 STATE。
  const sessionId = regenerateSessionId({ setCurrentAsParent: false })

  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try {
      closeSync(lockFd)
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // ignore
    }
  }

  return {
    sessionId,
    projectDir,
    transcriptPath,
    lockPath,
    dispose,
  }
}

/**
 * 測試用：產生一個假的 sessionId 但不動 process state（給單元測試
 * 驗證 lockfile 路徑/錯誤行為用）。
 */
export function _generateSessionIdForTest(): string {
  return randomUUID()
}

/**
 * 只釋放指定 projectDir 的 daemon lock（測試清理用）。
 * 真正流程請用 handle.dispose()。
 */
export function _releaseLockForTest(projectDir: string): void {
  try {
    unlinkSync(join(projectDir, '.daemon.lock'))
  } catch {
    // ignore
  }
  // 防 linter 抱怨未用 import
  void dirname
}
