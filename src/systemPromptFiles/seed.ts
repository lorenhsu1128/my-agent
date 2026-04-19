/**
 * System Prompt Externalization — 首次啟動種檔
 *
 * 目錄不存在 → mkdir + 寫入所有 externalized sections + README.md
 * 目錄已存在 → 完全不動（尊重使用者刻意刪除個別檔案）
 * 寫檔失敗（權限/唯讀）→ log warn，繼續走 bundled fallback
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  getSystemPromptGlobalDir,
  getSystemPromptGlobalFile,
} from './paths.js'
import { SECTIONS } from './sections.js'
import { BUNDLED_DEFAULTS, README_TEMPLATE } from './bundledDefaults.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'README.md'

/**
 * 若 global system-prompt 目錄不存在，建立並種入所有已外部化的預設檔 + README.md。
 * 已存在則直接 return；不補寫缺檔。
 */
export async function seedSystemPromptDirIfMissing(): Promise<void> {
  const dir = getSystemPromptGlobalDir()
  if (existsSync(dir)) return

  try {
    await mkdir(dir, { recursive: true })
    // README
    await writeFile(
      getSystemPromptGlobalFile(README_FILENAME),
      README_TEMPLATE,
      'utf-8',
    )
    // 各 section 預設檔
    for (const section of SECTIONS) {
      if (!section.externalized) continue
      const content = BUNDLED_DEFAULTS[section.id]
      if (content == null) continue
      const target = getSystemPromptGlobalFile(section.filename)
      // 如檔名含子目錄（errors/ memory/），先 mkdir
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf-8')
    }
    logForDebugging(
      `[systemPromptFiles] seeded ${dir} with ${SECTIONS.filter(s => s.externalized).length} default section(s)`,
    )
  } catch (err) {
    logForDebugging(
      `[systemPromptFiles] seed 失敗，繼續走 bundled fallback：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}
