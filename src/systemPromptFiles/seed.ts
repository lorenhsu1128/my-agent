/**
 * System Prompt Externalization — 首次啟動種檔
 *
 * 目錄不存在 → mkdir + 寫入所有 externalized sections + README.md
 * 目錄已存在 → **補寫缺檔**（個別 section / README 不存在則補；已存在尊重使用者）
 * 寫檔失敗（權限/唯讀）→ log warn，繼續走 bundled fallback
 *
 * Why 補寫缺檔：loader 規約「空字串 = 使用者刻意停用」，「檔案不存在 = 走 fallback」。
 * 使用者要 disable 應該清空檔案而非刪除；補寫缺檔不會覆蓋使用者刻意清空的檔。
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

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (existsSync(path)) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  return true
}

/**
 * 確保 global system-prompt 目錄齊全。第一次啟動會 mkdir + seed 所有檔；
 * 後續啟動會補寫使用者誤刪的檔（已存在的不動）。
 */
export async function seedSystemPromptDirIfMissing(): Promise<void> {
  const dir = getSystemPromptGlobalDir()
  let wrote = 0
  try {
    await mkdir(dir, { recursive: true })
    if (await writeIfMissing(getSystemPromptGlobalFile(README_FILENAME), README_TEMPLATE)) {
      wrote++
    }
    for (const section of SECTIONS) {
      if (!section.externalized) continue
      const content = BUNDLED_DEFAULTS[section.id]
      if (content == null) continue
      const target = getSystemPromptGlobalFile(section.filename)
      if (await writeIfMissing(target, content)) wrote++
    }
    if (wrote > 0) {
      logForDebugging(
        `[systemPromptFiles] seeded ${wrote} file(s) under ${dir}`,
      )
    }
  } catch (err) {
    logForDebugging(
      `[systemPromptFiles] seed 失敗，繼續走 bundled fallback：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}
