/**
 * System Prompt Externalization — 檔案載入
 *
 * 解析順序：per-project > global > bundled fallback
 * 使用 readFileSafe 包裝 ENOENT，缺檔回 null（由 loader 決定走下一層）。
 */
import { readFile } from 'fs/promises'
import type { SectionId } from './sections.js'
import { getSectionMeta } from './sections.js'
import {
  getSystemPromptGlobalFile,
  getSystemPromptProjectFile,
} from './paths.js'
import { getBundledDefault } from './bundledDefaults.js'

async function readFileSafe(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    // 剝除 Windows BOM
    return raw.replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

/**
 * 載入單一 section 的文字內容。
 *
 * 解析順序：
 *   1. per-project/<filename>
 *   2. global/<filename>
 *   3. bundled default（BUNDLED_DEFAULTS[id]，null 表尚未外部化）
 *
 * 空字串是合法覆蓋（使用者清空檔案），不會 fallback。
 * 檔案不存在才往下一層走。
 */
export async function loadSystemPromptSection(
  id: SectionId,
): Promise<string | null> {
  const meta = getSectionMeta(id)

  const projectPath = getSystemPromptProjectFile(meta.filename)
  const projectContent = await readFileSafe(projectPath)
  if (projectContent !== null) return projectContent

  const globalPath = getSystemPromptGlobalFile(meta.filename)
  const globalContent = await readFileSafe(globalPath)
  if (globalContent !== null) return globalContent

  return getBundledDefault(id)
}
