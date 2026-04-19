/**
 * User Modeling — 路徑解析 + 開關判定
 *
 * 雙層儲存：
 *   - Global：~/.my-agent/USER.md（跨所有專案共用 persona）
 *   - Per-project：~/.my-agent/projects/<slug>/USER.md（專案專屬 override）
 *
 * 三路開關優先序（先定義者勝）：
 *   1. MYAGENT_DISABLE_USER_MODEL env var（1/true → OFF）
 *   2. MY_AGENT_SIMPLE（--bare）→ OFF（延續 auto memory 的 bare 行為）
 *   3. settings.json: userModelEnabled（true/false）
 *   4. 預設啟用
 *
 * CLI flag（--no-user-model / --user-model）走 `MYAGENT_USER_MODEL_CLI_OVERRIDE`
 * 由 CLI 參數解析後寫入 env，順便在 1) 前被判讀。
 */
import { dirname, join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'
import { getAutoMemPath } from '../memdir/paths.js'
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { getInitialSettings } from '../utils/settings/settings.js'

export const USER_MODEL_FILENAME = 'USER.md'

/**
 * Global USER.md 路徑：~/.my-agent/USER.md
 * env override: MYAGENT_USER_MODEL_PATH（完整絕對路徑）
 */
export function getUserModelGlobalPath(): string {
  const override = process.env.MYAGENT_USER_MODEL_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  return join(getMemoryBaseDir(), USER_MODEL_FILENAME)
}

/**
 * Per-project USER.md 路徑：~/.my-agent/projects/<slug>/USER.md
 *
 * 複用 getAutoMemPath() 的 project slug 解析，去掉末端 `memory/`，
 * 以確保 git-root canonicalization / worktree 合併等行為一致。
 */
export function getUserModelProjectPath(): string {
  const memDir = getAutoMemPath()
  // getAutoMemPath() 回傳末端含 sep 的 ...<slug>/memory/
  // 去掉末尾 sep 再取 dirname → ...<slug>
  const trimmed = memDir.replace(/[/\\]+$/, '')
  const projectDir = dirname(trimmed)
  return join(projectDir, USER_MODEL_FILENAME)
}

/**
 * 使用者建模是否啟用。三路開關（見檔頭註解）。
 */
export function isUserModelEnabled(): boolean {
  const envVal = process.env.MYAGENT_DISABLE_USER_MODEL
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // 承襲 auto memory 的 bare 行為
  if (isEnvTruthy(process.env.MY_AGENT_SIMPLE)) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.userModelEnabled !== undefined) {
    return settings.userModelEnabled
  }
  return true
}
