/**
 * llama.cpp 設定檔載入 + session 凍結快照。
 *
 * 模式沿用 src/userModel/userModel.ts：
 *   - loadLlamaCppConfigSnapshot() session 啟動時呼叫一次並凍結
 *   - getLlamaCppConfigSnapshot() 同步回傳凍結結果
 *   - 檔案不存在 / JSON 壞 / schema 失敗 → 走 DEFAULT_LLAMACPP_CONFIG + stderr warn
 */
import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { getLlamaCppConfigPath } from './paths.js'
import {
  DEFAULT_LLAMACPP_CONFIG,
  LlamaCppConfigSchema,
  type LlamaCppConfig,
} from './schema.js'

let cached: LlamaCppConfig | null = null
let loadInFlight: Promise<LlamaCppConfig> | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(`[llamacpp-config] ${reason}；走內建預設`)
}

async function readLive(): Promise<LlamaCppConfig> {
  const path = getLlamaCppConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    // 缺檔不報錯；seed 階段會補寫，或使用者刻意刪除也尊重
    return DEFAULT_LLAMACPP_CONFIG
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSON 解析失敗：${e instanceof Error ? e.message : String(e)}`,
    )
    return DEFAULT_LLAMACPP_CONFIG
  }
  const result = LlamaCppConfigSchema.safeParse(parsed)
  if (!result.success) {
    warnOnce(`${path} schema 驗證失敗：${result.error.message}`)
    return DEFAULT_LLAMACPP_CONFIG
  }
  return result.data
}

export async function loadLlamaCppConfigSnapshot(): Promise<LlamaCppConfig> {
  if (cached) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(cfg => {
    cached = cfg
    loadInFlight = null
    return cfg
  })
  return loadInFlight
}

export function getLlamaCppConfigSnapshot(): LlamaCppConfig {
  if (cached) return cached
  // setup.ts 的 fire-and-forget 載入可能還沒跑完，同步讀檔避免拿到錯誤的預設值
  try {
    const raw = readFileSync(getLlamaCppConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw.replace(/^﻿/, ''))
    const result = LlamaCppConfigSchema.safeParse(parsed)
    if (result.success) {
      cached = result.data
      return cached
    }
  } catch {
    // 檔案不存在或解析失敗，走預設
  }
  return DEFAULT_LLAMACPP_CONFIG
}

/**
 * 是否啟用 vision 翻譯（M-VISION）。
 * adapter 依此決定 image block → OpenAI `image_url` 還是 `[Image attachment]` 字串佔位符。
 */
export function isVisionEnabled(): boolean {
  return getLlamaCppConfigSnapshot().vision.enabled
}

export function _resetLlamaCppConfigForTests(): void {
  cached = null
  loadInFlight = null
  warned = false
}
