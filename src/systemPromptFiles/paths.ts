/**
 * System Prompt Externalization — 路徑解析
 *
 * 雙層儲存：
 *   - Global：~/.my-agent/system-prompt/
 *   - Per-project：~/.my-agent/projects/<slug>/system-prompt/
 *
 * 複用 memdir/paths.ts 的 getMemoryBaseDir() + getAutoMemPath() slug 解析，
 * 確保與 USER.md / memdir 的 project slug 一致。
 */
import { dirname, join } from 'path'
import { getMemoryBaseDir, getAutoMemPath } from '../memdir/paths.js'

export const SYSTEM_PROMPT_DIRNAME = 'system-prompt'

/**
 * Global system-prompt 目錄：~/.my-agent/system-prompt/
 */
export function getSystemPromptGlobalDir(): string {
  return join(getMemoryBaseDir(), SYSTEM_PROMPT_DIRNAME)
}

/**
 * Per-project system-prompt 目錄：~/.my-agent/projects/<slug>/system-prompt/
 *
 * 複用 getAutoMemPath() 的 slug 解析（去掉末端 `memory/` → 取 project dir）。
 */
export function getSystemPromptProjectDir(): string {
  const memDir = getAutoMemPath()
  const trimmed = memDir.replace(/[/\\]+$/, '')
  const projectDir = dirname(trimmed)
  return join(projectDir, SYSTEM_PROMPT_DIRNAME)
}

/**
 * 解析某個 section 在 global 層的完整檔案路徑。
 * filename 可含子目錄（例：`memory/types-combined.md`、`errors/max-turns.md`）。
 */
export function getSystemPromptGlobalFile(filename: string): string {
  return join(getSystemPromptGlobalDir(), filename)
}

export function getSystemPromptProjectFile(filename: string): string {
  return join(getSystemPromptProjectDir(), filename)
}
