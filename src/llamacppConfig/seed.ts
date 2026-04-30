/**
 * 首次啟動 seed + 既有 strict JSON → JSONC 格式升級。
 *
 * 行為：
 *   - 檔案不存在 → 寫入 LLAMACPP_JSONC_TEMPLATE（含繁中註解）
 *   - 檔案存在且是 strict JSON（無 JSONC 註解）→ 重寫為 JSONC 模板（保留使用者原值）
 *   - 檔案存在且已是 JSONC（有註解）→ 完全不動
 *   - 既有 README.md（*.README.md）保留原樣（M-LLAMA-CFG 時期的文件仍有深度說明價值）
 *
 * 失敗時 graceful fallback：warn stderr 繼續，不阻擋 boot。
 */
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { getLlamaCppConfigPath } from './paths.js'
import { DEFAULT_LLAMACPP_CONFIG, LlamaCppConfigSchema } from './schema.js'
import { LLAMACPP_JSONC_TEMPLATE } from './bundledTemplate.js'
import {
  parseJsonc,
  writeJsoncPreservingComments,
  forceRewriteJsoncFile,
} from '../utils/jsoncStore.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'llamacpp.README.md'

/**
 * Template hardcodes Windows 副檔名。seed 時依平台改寫 binaryPath，
 * 讓 macOS / Linux 使用者首次拿到的就是正確路徑（不用手動編輯）。
 */
function localizeTemplate(template: string): string {
  if (process.platform === 'win32') return template
  return template.replace(
    'buun-llama-cpp/build/bin/Release/llama-server.exe',
    'buun-llama-cpp/build/bin/llama-server',
  )
}

// 既有 README 內容（M-LLAMA-CFG 時期的深度說明）。
// 註解已搬到 JSONC 模板內；此 README 只在檔案不存在時 seed，已存在就不動。
const README_CONTENT = `# ~/.my-agent/llamacpp.json

本檔為 my-agent 與 \`scripts/llama/serve.sh\` **共用**的本地 LLM server 設定來源。

每個欄位的繁體中文說明已內嵌在 \`llamacpp.json\` 檔案本身（JSONC 格式，支援 // 與 /* */ 註解）。
本 README 保留給「為何這麼設計 / 如何搭配 shell 端 / 復原與 env var」等跨檔資訊。

## 單一來源雙端共用

- my-agent TS 端：透過 \`src/llamacppConfig/loader.ts\` 讀取，session 啟動時凍結快照。
- shell 端：透過 \`scripts/llama/load-config.sh\` 以 \`jq\` 抽出 env vars，再由 \`serve.sh\` 啟動 llama-server 時使用。

## Env var 覆蓋（優先於檔案）

| Env | 覆蓋欄位 |
|-----|---------|
| \`LLAMA_BASE_URL\` | baseUrl |
| \`LLAMA_MODEL\` | model |
| \`LLAMACPP_CTX_SIZE\` | contextSize（僅 client 端） |
| \`LLAMACPP_COMPACT_BUFFER\` | autoCompactBufferTokens |
| \`LLAMA_DEBUG\` | debug |
| \`LLAMA_HOST\` / \`LLAMA_PORT\` / \`LLAMA_CTX\` / \`LLAMA_NGL\` / \`LLAMA_ALIAS\` | server.* 對應欄位（僅 shell 端） |
| \`LLAMACPP_CONFIG_PATH\` | 整個設定檔路徑 |

## 復原

- 刪掉 \`llamacpp.json\` → 下次啟動自動重新 seed（註解會回來）。
- 刪掉此 README 不影響功能。
- JSON 語法壞 / schema 不符 → my-agent stderr 警告並走內建預設，不 crash。

## JSONC 格式

本檔從 v2026-04-25 起採用 JSONC（JSON with Comments），支援：
- \`// 單行註解\`
- \`/* 區塊註解 */\`
- 尾部逗號（array / object）

my-agent 寫回此檔時會保留使用者加的註解。
`

/**
 * 判斷文字是否為 strict JSON（需要升級為 JSONC）。
 * 策略：嚴格 JSON.parse 能通過 → 表示沒有 JSONC 延伸（註解、尾部逗號），需要 migrate。
 */
function isStrictJson(text: string): boolean {
  const stripped = text.replace(/^﻿/, '').trim()
  if (!stripped) return false
  try {
    JSON.parse(stripped)
    return true
  } catch {
    return false
  }
}

/**
 * Migration：把既有 strict JSON 升級為帶註解的 JSONC。
 *
 * 策略：取 LLAMACPP_JSONC_TEMPLATE 當底 → 逐欄位把使用者現值套回去
 *       → 保留模板所有註解。
 *
 * 寫入前備份為 `<path>.pre-jsonc-<timestamp>`。
 */
async function migrateStrictJsonToJsonc(
  path: string,
  originalText: string,
): Promise<void> {
  let userValue: unknown
  try {
    userValue = JSON.parse(originalText.replace(/^﻿/, ''))
  } catch (err) {
    logForDebugging(
      `[llamacpp-config] migration skip：JSON parse 失敗（${err instanceof Error ? err.message : String(err)}）`,
      { level: 'warn' },
    )
    return
  }
  // Validate：壞值就不動原檔，使用者手動修
  const validated = LlamaCppConfigSchema.safeParse(userValue)
  if (!validated.success) {
    logForDebugging(
      `[llamacpp-config] migration skip：schema 驗證失敗（${validated.error.message}），保留原檔`,
      { level: 'warn' },
    )
    return
  }

  // 以模板為基底，把 validated 值套進去（保留註解）
  const localized = localizeTemplate(LLAMACPP_JSONC_TEMPLATE)
  const templateParsed = parseJsonc(localized)
  void templateParsed // used as sanity check that template itself is valid
  const { newText } = await writeJsoncPreservingComments(
    path, // 這裡的 path 僅供錯誤訊息；實際寫入走 forceRewrite
    localized,
    validated.data,
  )
  // forceRewrite 會備份既有檔
  await forceRewriteJsoncFile(path, newText)
  logForDebugging(
    `[llamacpp-config] migrated strict JSON → JSONC with comments：${path}`,
  )
}

export async function seedLlamaCppConfigIfMissing(): Promise<void> {
  const path = getLlamaCppConfigPath()
  try {
    if (!existsSync(path)) {
      // 首次 seed
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, localizeTemplate(LLAMACPP_JSONC_TEMPLATE), 'utf-8')
      // README sidecar（若不存在才寫，已存在尊重使用者）
      const readmePath = join(dirname(path), README_FILENAME)
      if (!existsSync(readmePath)) {
        await writeFile(readmePath, README_CONTENT, 'utf-8')
      }
      logForDebugging(`[llamacpp-config] seeded ${path} (JSONC)`)
      return
    }

    // 檔案存在 → 判斷是否為 strict JSON 需要 migrate
    const existingText = await readFile(path, 'utf-8')
    if (isStrictJson(existingText)) {
      await migrateStrictJsonToJsonc(path, existingText)
    }
    // 若已是 JSONC（有註解），完全不動
  } catch (err) {
    logForDebugging(
      `[llamacpp-config] seed 失敗，繼續走內建預設：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

// 供 fallback 檢查使用；DEFAULT_LLAMACPP_CONFIG 已經從 schema 匯出
export { DEFAULT_LLAMACPP_CONFIG }
