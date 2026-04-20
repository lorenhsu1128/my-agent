/**
 * M-DAEMON-AUTO：Daemon auto-start 行為。
 *
 * REPL 首次偵測 no-daemon 時（M-DAEMON-AUTO-B），若 config.daemonAutoStart
 * 啟用，就 spawn 一個 detached daemon 背景跑。detached 讓 daemon 不跟 REPL
 * 共存亡（Q2=a：persistent），再開 REPL 直接 attach。
 *
 * Session-level flag（`hasAttemptedAutostartThisSession`）保證同一個 REPL
 * session 只試一次 — 使用者中途外部把 daemon 停掉，REPL 不會自動再
 * re-spawn（Q1=c）。
 *
 * Opt-out（Q3=C 提供兩個管道）：
 *   - `my-agent daemon autostart off`（CLI，持久寫 config）
 *   - REPL `/daemon off`（slash，立即 + 持久）
 * 還有臨時 env `MY_AGENT_NO_DAEMON_AUTOSTART=1`（測試 / CI 用，不改 config）。
 */
import { spawn } from 'child_process'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { isEnvTruthy } from '../utils/envUtils.js'

/**
 * 預設 autostart 狀態：config 沒設（undefined）= true；顯式 false 才停用。
 */
export function isAutostartEnabled(): boolean {
  if (isEnvTruthy(process.env.MY_AGENT_NO_DAEMON_AUTOSTART)) return false
  const v = getGlobalConfig().daemonAutoStart
  if (v === false) return false
  return true
}

export function setAutostartEnabled(enabled: boolean): void {
  saveGlobalConfig(cur => ({
    ...cur,
    daemonAutoStart: enabled,
  }))
}

export interface SpawnResult {
  /** 是否真的 fork 出去了（有可能 env 擋 / config 擋 / 已試過）。 */
  spawned: boolean
  /** 若失敗的錯誤訊息。 */
  error?: string
  /** fork 出去的子程序 pid（不代表 daemon pid，而是 spawn 的 bun/cli 程序）。 */
  childPid?: number
}

/**
 * Fire-and-forget 起一個 detached daemon。回傳 `spawned: true` 只代表
 * `spawn()` 沒拋錯；daemon 實際就緒狀態要靠 detector 輪詢 pidfile 確認
 * （M-DAEMON-AUTO-B REPL 會接這段）。
 */
export function spawnDetachedDaemon(opts: {
  /** 繼承當下的 CLI / bun 執行檔路徑；回傳命令 + args tuple。 */
  executable?: string
  args?: string[]
  /** 傳給子程序的額外 env（merge on top of process.env）。 */
  env?: NodeJS.ProcessEnv
} = {}): SpawnResult {
  const { executable, args } = resolveExecutable(opts.executable, opts.args)
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    })
    child.unref()
    return { spawned: true, childPid: child.pid }
  } catch (err) {
    return {
      spawned: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 決定要 exec 哪個 binary + args：
 *   - 包好的 `./cli.exe`：argv[0] 就是 cli.exe，args = `['daemon','start']`
 *   - bun + src script：argv[0]=bun、argv[1]=entry script，args = `[argv[1],'daemon','start']`
 *   - 測試覆寫：直接尊重 `opts.executable` / `opts.args`
 */
function resolveExecutable(
  execOverride?: string,
  argsOverride?: string[],
): { executable: string; args: string[] } {
  if (execOverride) {
    return {
      executable: execOverride,
      args: argsOverride ?? ['daemon', 'start'],
    }
  }
  const argv = process.argv
  const isBunScript = argv[1] !== undefined && /\.tsx?$|\.jsx?$/.test(argv[1])
  if (isBunScript) {
    return {
      executable: argv[0]!,
      args: [argv[1]!, 'daemon', 'start'],
    }
  }
  // 包好的單一 binary。
  return {
    executable: argv[0]!,
    args: ['daemon', 'start'],
  }
}

// ---- Session-level 首次 spawn 紀錄（Q1=c） ----
let hasAttemptedAutostartThisSession = false

/** 測試用：重置 session flag。 */
export function _resetAutostartSessionFlagForTest(): void {
  hasAttemptedAutostartThisSession = false
}

export function hasAttemptedAutostart(): boolean {
  return hasAttemptedAutostartThisSession
}

/** 標記本 session 已 attempt；回傳前值。 */
export function markAutostartAttempted(): boolean {
  const prev = hasAttemptedAutostartThisSession
  hasAttemptedAutostartThisSession = true
  return prev
}
