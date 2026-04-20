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
import { openSync, closeSync, unlinkSync, mkdirSync, writeSync } from 'fs'
import { dirname, join } from 'path'
import { regenerateSessionId } from '../bootstrap/state.js'
import { getProjectDir } from '../utils/sessionStorage.js'

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
  // `wx` 獨占建立；如果已存在就丟錯（有另一個 daemon 活著／上次沒清乾淨）。
  let lockFd: number
  try {
    lockFd = openSync(lockPath, 'wx', 0o600)
    writeSync(
      lockFd,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n',
    )
  } catch (e) {
    throw new Error(
      `Failed to acquire daemon session lock at ${lockPath}: ${e instanceof Error ? e.message : String(e)}. ` +
        `If no daemon is running, remove the file manually.`,
    )
  }

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
