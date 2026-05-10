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
  getOverrideGlobalFile,
} from './paths.js'
import { SECTIONS } from './sections.js'
import { BUNDLED_DEFAULTS, README_TEMPLATE } from './bundledDefaults.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'README.md'

/**
 * M-SP-FULL Phase 2：把 29 個 bundled default section 拼成完整字串，當作
 * `system-prompt-override.md` 的 seed 起點。
 *
 * 設計取捨：
 * - 不嘗試對齊 `getSystemPrompt()` 動態組裝的精確順序（USER_TYPE / feature flag
 *   分支會讓那條路徑非確定）。
 * - 改用 SECTIONS 註冊表的固定順序，每段以 `<!-- ===== <id> ===== -->` 註解分隔，
 *   方便使用者直觀辨識「這段是什麼」。
 * - 純 markdown，可整段註解掉、整段刪除。
 * - 跳過 null / 未外部化 / 為空字串的 section（與既有 loader 規約一致）。
 */
export function composeFullDefaultPrompt(): string {
  const header = [
    '<!--',
    'M-SP-FULL Phase 2 — auto-seeded default system prompt 拷貝。',
    '',
    '編輯本檔即覆蓋整個 default 主 prompt（user/memory/env 等動態段仍會由程式注入）。',
    '刪除本檔即回到 my-agent 內建 default。',
    '',
    '⚠️ my-agent 升級若改了 bundled default，本檔不會自動跟進；',
    '   要重新拿到最新 default：刪除本檔 + 重啟（會重 seed）。',
    '',
    '優先序：',
    '  per-project: ~/.my-agent/projects/<slug>/system-prompt-override.md',
    '  global:      ~/.my-agent/system-prompt-override.md（本檔）',
    '  default:     bundled（本檔不存在或被刪時 fallback）',
    '-->',
    '',
  ].join('\n')

  const body: string[] = []
  for (const section of SECTIONS) {
    if (!section.externalized) continue
    const content = BUNDLED_DEFAULTS[section.id]
    if (content == null || content === '') continue
    body.push(`<!-- ===== ${section.id} ===== -->`)
    body.push(content)
    body.push('') // 段落間空行
  }

  return header + body.join('\n')
}

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

    // M-SP-FULL Phase 2：seed global system-prompt-override.md（使用者編輯起點）。
    // append.md 不 seed —— append 預期是少量追加文字，沒有「拿 default 當起點」
    // 的需求，且空檔會踩 loader 規約「空字串 = 明確覆蓋」陷阱。
    // 注意：override.md 在 system-prompt/ 同層 sibling，不在 dir 內。
    if (await writeIfMissing(getOverrideGlobalFile(), composeFullDefaultPrompt())) {
      wrote++
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
