/**
 * System Prompt Externalization — 路徑解析
 *
 * 雙層儲存：
 *   - Global：~/.my-agent/system-prompt/
 *   - Per-project：~/.my-agent/projects/<slug>/system-prompt/
 *
 * Project slug：依 cwd 找 canonical git root，sanitize 後當 slug。
 *
 * 兩組 API：
 *   - 無 cwd 版（`getSystemPromptProjectDir()` / `getSystemPromptProjectFile()`）：
 *     沿用 `getAutoMemPath()`，process-level project root，REPL 路徑用。
 *   - 帶 cwd 版（`getSystemPromptProjectDirForCwd(cwd)` / 對應檔案 helper）：
 *     M-SP-FULL Phase 1 新增，daemon multi-project 用，避免 module-level 共用。
 *
 * 兩組路徑對相同 cwd 應算出同一個 slug。
 */
import { dirname, join } from 'path'
import { getMemoryBaseDir, getAutoMemPath } from '../memdir/paths.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'

export const SYSTEM_PROMPT_DIRNAME = 'system-prompt'
export const PROJECTS_DIRNAME = 'projects'

/**
 * Override / append 兩個檔（M-SP-FULL Phase 2）：
 *   - override.md：完全替代 default 主 prompt（對應 customSystemPrompt 鉤子）
 *   - append.md：追加在最後（對應 appendSystemPrompt 鉤子）
 *
 * 兩者各自獨立解析，可同時存在。優先序：per-project > global。
 * 與 SECTION 檔（必須在 system-prompt/ 子目錄內）不同，這兩個檔是 system-prompt
 * 同層 sibling，命名直接帶 `system-prompt-` 前綴方便辨識。
 */
export const OVERRIDE_FILENAME = 'system-prompt-override.md'
export const APPEND_FILENAME = 'system-prompt-append.md'

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
 * 注意：此函數讀 process-level state（getProjectRoot）。daemon 多 project
 * 場景請改用 `getSystemPromptProjectDirForCwd(cwd)`。
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

/**
 * M-SP-FULL Phase 1：依 cwd 算 project slug（不依賴 process-level state）。
 *
 * Slug = sanitize(canonicalGitRoot(cwd) ?? cwd)，與 memdir.getAutoMemPath()
 * 對相同 cwd 算出的 slug 一致。
 */
export function getProjectSlugForCwd(cwd: string): string {
  const base = findCanonicalGitRoot(cwd) ?? cwd
  return sanitizePath(base)
}

/**
 * Per-project system-prompt 目錄 — 帶 cwd 版（daemon multi-project 用）。
 */
export function getSystemPromptProjectDirForCwd(cwd: string): string {
  const slug = getProjectSlugForCwd(cwd)
  return join(getMemoryBaseDir(), PROJECTS_DIRNAME, slug, SYSTEM_PROMPT_DIRNAME)
}

/**
 * Per-project system-prompt 檔案 — 帶 cwd 版。
 */
export function getSystemPromptProjectFileForCwd(
  cwd: string,
  filename: string,
): string {
  return join(getSystemPromptProjectDirForCwd(cwd), filename)
}

/**
 * M-SP-FULL Phase 2：override / append 檔的路徑。
 * 注意：override.md / append.md 不在 `system-prompt/` 子目錄裡，而是與其同層
 * 的 sibling，所以路徑用 `dirname(...) + filename`。
 */
export function getOverrideGlobalFile(): string {
  return join(getMemoryBaseDir(), OVERRIDE_FILENAME)
}
export function getAppendGlobalFile(): string {
  return join(getMemoryBaseDir(), APPEND_FILENAME)
}
export function getOverrideProjectFileForCwd(cwd: string): string {
  const slug = getProjectSlugForCwd(cwd)
  return join(getMemoryBaseDir(), PROJECTS_DIRNAME, slug, OVERRIDE_FILENAME)
}
export function getAppendProjectFileForCwd(cwd: string): string {
  const slug = getProjectSlugForCwd(cwd)
  return join(getMemoryBaseDir(), PROJECTS_DIRNAME, slug, APPEND_FILENAME)
}
