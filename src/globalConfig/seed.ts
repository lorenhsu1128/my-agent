/**
 * 全域設定檔 seed：~/.my-agent/.my-agent.json 不存在時寫入完整模板。
 *
 * 與 llamacppConfig / discordConfig 不同：GlobalConfig 由 src/utils/config.ts
 * 的 `saveGlobalConfig` → `saveConfigWithLock` 在首次 `getGlobalConfig()` 後
 * 寫入。此 seed 函式在那之前搶先寫入帶繁中註解的模板版本，讓使用者第一
 * 次打開 ~/.my-agent/.my-agent.json 就看到完整欄位說明。
 *
 * 注意：目前 saveConfigWithLock 會把「等於預設值的欄位」過濾掉再寫回
 * （`pickBy(cfg, ≠ defaults)`），因此**模板產生的註解在下次寫回時會被
 * 洗掉**。要真正保留需要配合 M-CONFIG-JSONC-SAVE（saveGlobalConfig
 * 路徑改用 jsoncStore.writeJsoncPreservingComments）。
 *
 * 在 M-CONFIG-JSONC-SAVE 做完前，此 seed 提供的價值是：
 *   - 全新使用者首次啟動可以看到完整 schema + 中文解釋一次
 *   - 現有使用者可以透過手動觸發（未來 slash command /config-rewrite-with-docs）
 *     重新落盤看完整版本
 */
import { existsSync } from 'fs'
import { dirname } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { GLOBAL_CONFIG_JSONC_TEMPLATE } from './bundledTemplate.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * 首次落盤：檔案不存在才寫；已存在（含 strict JSON 版本）不動，等
 * M-CONFIG-JSONC-SAVE 的 migration 自動升級。
 *
 * 必須在 getGlobalConfig 第一次被呼叫之前跑，否則會被 saveConfigWithLock
 * 搶先寫出 stripped-defaults 的 strict JSON 檔。
 */
export async function seedGlobalConfigIfMissing(path: string): Promise<void> {
  try {
    if (existsSync(path)) return
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, GLOBAL_CONFIG_JSONC_TEMPLATE, 'utf-8')
    logForDebugging(`[global-config] seeded ${path} (JSONC with 繁中 comments)`)
  } catch (err) {
    logForDebugging(
      `[global-config] seed 失敗，繼續使用 getGlobalConfig 預設：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

/**
 * 手動觸發：重寫 ~/.my-agent/.my-agent.json 為當前 bundled 模板版本，
 * 保留使用者現有值。寫前備份為 `*.pre-rewrite-<timestamp>`。
 *
 * 用途：
 *   - 使用者看過舊版註解後，想取得最新模板（欄位新增 / 說明更新）
 *   - 一次性強制升級 strict JSON → JSONC 版本
 *
 * 此函式會讀 current config、JSON.parse、以模板為底套回所有欄位，然後
 * 透過 jsoncStore.writeJsoncPreservingComments 寫出（保留模板註解）。
 */
export async function forceRewriteGlobalConfigWithDocs(
  path: string,
): Promise<{ backupPath: string | null }> {
  const {
    forceRewriteJsoncFile,
    writeJsoncPreservingComments,
    parseJsonc,
  } = await import('../utils/jsoncStore.js')
  const { readFile } = await import('fs/promises')

  let currentValue: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
      // 可能是 strict JSON、可能是 JSONC — parseJsonc 兩個都吃
      currentValue = parseJsonc<Record<string, unknown>>(raw)
    } catch {
      currentValue = {}
    }
  }

  // 以模板為 baseline，套用使用者現有值
  const templateParsed = parseJsonc<Record<string, unknown>>(
    GLOBAL_CONFIG_JSONC_TEMPLATE,
  )
  const merged: Record<string, unknown> = { ...templateParsed }
  for (const [key, value] of Object.entries(currentValue)) {
    merged[key] = value
  }

  // 先用 writeJsoncPreservingComments 產出帶註解的新文字
  const { newText } = await writeJsoncPreservingComments(
    path,
    GLOBAL_CONFIG_JSONC_TEMPLATE,
    merged,
  )
  // 再用 forceRewrite 完成備份 + atomic overwrite
  return await forceRewriteJsoncFile(path, newText)
}
