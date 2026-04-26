/**
 * Web UI 設定載入 + session 凍結快照。
 *
 * 沿用 llamacppConfig / discordConfig pattern：
 *   - loadWebConfigSnapshot() 啟動時呼叫一次 + 凍結
 *   - getWebConfigSnapshot() 同步回傳凍結結果
 *   - 檔案不存在 / JSON 壞 / schema 失敗 → 走 DEFAULT + stderr warn
 */
import { readFile, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { getWebConfigPath } from './paths.js'
import {
  DEFAULT_WEB_CONFIG,
  WebConfigSchema,
  type WebConfig,
} from './schema.js'
import {
  parseJsonc,
  writeJsoncPreservingComments,
} from '../utils/jsoncStore.js'

let cached: WebConfig | null = null
let loadInFlight: Promise<WebConfig> | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(`[web-config] ${reason}；走內建預設（enabled=false）`)
}

async function readLive(): Promise<WebConfig> {
  const path = getWebConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return DEFAULT_WEB_CONFIG
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw.replace(/^﻿/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSONC 解析失敗：${e instanceof Error ? e.message : String(e)}`,
    )
    return DEFAULT_WEB_CONFIG
  }
  const result = WebConfigSchema.safeParse(parsed)
  if (!result.success) {
    warnOnce(`${path} schema 驗證失敗：${result.error.message}`)
    return DEFAULT_WEB_CONFIG
  }
  return result.data
}

export async function loadWebConfigSnapshot(): Promise<WebConfig> {
  if (cached) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(cfg => {
    cached = cfg
    loadInFlight = null
    return cfg
  })
  return loadInFlight
}

export function getWebConfigSnapshot(): WebConfig {
  if (cached) return cached
  // setup.ts 的 fire-and-forget 載入可能還沒跑完，同步讀檔避免拿到錯誤的預設值
  try {
    const path = getWebConfigPath()
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseJsonc(raw.replace(/^﻿/, ''))
    const result = WebConfigSchema.safeParse(parsed)
    if (result.success) {
      cached = result.data
      return cached
    }
  } catch {
    // 檔案不存在或解析失敗，走預設
  }
  return DEFAULT_WEB_CONFIG
}

export function isWebEnabled(): boolean {
  return getWebConfigSnapshot().enabled
}

/**
 * Atomic 寫回 web.jsonc 的單一欄位 + in-place mutate cached snapshot。
 * 對應 `/web config <key> <value>` 指令的後端寫入。
 */
export async function updateWebConfigField<K extends keyof WebConfig>(
  key: K,
  value: WebConfig[K],
): Promise<void> {
  const cfg = await loadWebConfigSnapshot()
  const path = getWebConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    raw = ''
  }
  let parsed: Record<string, unknown>
  try {
    parsed = (raw.trim().length > 0
      ? parseJsonc(raw.replace(/^﻿/, ''))
      : {}) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  parsed[key as string] = value as unknown
  // 驗證整體仍合法後再寫
  const merged = WebConfigSchema.safeParse({
    ...DEFAULT_WEB_CONFIG,
    ...parsed,
  })
  if (!merged.success) {
    throw new Error(
      `web.jsonc 更新失敗：${merged.error.message}（key=${String(key)}）`,
    )
  }
  if (raw.trim().length > 0) {
    await writeJsoncPreservingComments(path, raw.replace(/^﻿/, ''), parsed)
  } else {
    // 沒原檔（極少見：seed 失敗）→ 直接寫 strict JSON
    await writeFile(path, JSON.stringify(parsed, null, 2), 'utf-8')
  }
  // in-place mutate cached（gateway / status RPC 共用 reference）
  ;(cfg as Record<string, unknown>)[key as string] = value as unknown
}

export function _resetWebConfigForTests(): void {
  cached = null
  loadInFlight = null
  warned = false
}
