/**
 * 全域設定檔 seed：~/.my-agent/.my-agent.jsonc 不存在時寫入完整模板。
 *
 * 與 llamacppConfig / discordConfig 不同：GlobalConfig 由 src/utils/config.ts
 * 的 `saveGlobalConfig` → `saveConfigWithLock` 在首次 `getGlobalConfig()` 後
 * 寫入。此 seed 函式在那之前搶先寫入帶繁中註解的模板版本，讓使用者第一
 * 次打開 ~/.my-agent/.my-agent.jsonc 就看到完整欄位說明。
 *
 * JSONC 註解保留：saveConfigWithLock（src/utils/config.ts:1216）已在原檔含
 * 註解時走 jsonc.modify 路徑套變更，保留所有使用者加的繁中註解。檔案若是
 * 純 strict JSON 才會走 filter-defaults + jsonStringify 的 legacy 路徑。
 * 回歸測試：tests/integration/jsonc/saveGlobalConfig-preserve.test.ts。
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
 * 同步版本 — 給 `enableConfigs()` 使用。在第一次 `getConfig` 之前 fallthrough
 * 把 JSONC 模板落盤，避免新使用者第一次 saveGlobalConfig 寫出 stripped JSON。
 */
export function seedGlobalConfigIfMissingSync(path: string): void {
  try {
    if (existsSync(path)) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, GLOBAL_CONFIG_JSONC_TEMPLATE, 'utf-8')
    logForDebugging(
      `[global-config] seeded ${path} (JSONC with 繁中 comments, sync)`,
    )
  } catch (err) {
    logForDebugging(
      `[global-config] sync seed 失敗：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

/**
 * 手動觸發：重寫 ~/.my-agent/.my-agent.jsonc 為當前 bundled 模板版本，
 * 保留使用者現有值，**並剔除非 my-agent schema 的欄位**（典型來源：使用者
 * 從 upstream 的 `~/.my-agent/config.json` 整份複製過來，帶了 tipsHistory /
 * cachedGrowthBookFeatures / btwUseCount / oauthAccount 等 my-agent 不使用
 * 的欄位）。被剔除的 keys 列在回傳值，呼叫端可顯示給使用者。
 *
 * 寫前備份為 `*.pre-rewrite-<timestamp>`，原始值不會丟失。
 *
 * Allowlist 來源：`createDefaultGlobalConfig()` 的 top-level keys。新增 my-agent
 * 欄位時自動納入；被剔除的欄位若日後 my-agent 想用，把它加進 default config
 * 即可。
 */
export async function forceRewriteGlobalConfigWithDocs(
  path: string,
): Promise<{ backupPath: string | null; droppedKeys: string[] }> {
  const {
    forceRewriteJsoncFile,
    writeJsoncPreservingComments,
    parseJsonc,
  } = await import('../utils/jsoncStore.js')
  const { readFile } = await import('fs/promises')
  const { DEFAULT_GLOBAL_CONFIG } = await import('../utils/config.js')

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

  // 以模板為 baseline，套用使用者現有值；非 my-agent schema 的 key 剔除
  const templateParsed = parseJsonc<Record<string, unknown>>(
    GLOBAL_CONFIG_JSONC_TEMPLATE,
  )
  const allowedKeys = new Set<string>([
    ...Object.keys(DEFAULT_GLOBAL_CONFIG as Record<string, unknown>),
    // 模板裡標註過的欄位也視為合法（包含 deprecated 但我們仍接受讀回的）
    ...Object.keys(templateParsed),
  ])
  const merged: Record<string, unknown> = { ...templateParsed }
  const droppedKeys: string[] = []
  for (const [key, value] of Object.entries(currentValue)) {
    if (!allowedKeys.has(key)) {
      droppedKeys.push(key)
      continue
    }
    merged[key] = value
  }

  // 先用 writeJsoncPreservingComments 產出帶註解的新文字
  const { newText } = await writeJsoncPreservingComments(
    path,
    GLOBAL_CONFIG_JSONC_TEMPLATE,
    merged,
  )
  // 再用 forceRewrite 完成備份 + atomic overwrite
  const { backupPath } = await forceRewriteJsoncFile(path, newText)
  return { backupPath, droppedKeys }
}
