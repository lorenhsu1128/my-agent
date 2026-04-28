/**
 * llama.cpp 設定檔載入 + session 凍結快照。
 *
 * 模式沿用 src/userModel/userModel.ts：
 *   - loadLlamaCppConfigSnapshot() session 啟動時呼叫一次並凍結
 *   - getLlamaCppConfigSnapshot() 同步回傳凍結結果
 *   - 檔案不存在 / JSON 壞 / schema 失敗 → 走 DEFAULT_LLAMACPP_CONFIG + stderr warn
 */
import { readFile } from 'fs/promises'
import { readFileSync, statSync } from 'fs'
import { getLlamaCppConfigPath } from './paths.js'
import {
  DEFAULT_LLAMACPP_CONFIG,
  LlamaCppConfigSchema,
  type LlamaCppCallSite,
  type LlamaCppConfig,
  type LlamaCppRoutingTarget,
} from './schema.js'
import { parseJsonc } from '../utils/jsoncStore.js'

let cached: LlamaCppConfig | null = null
let cachedMtimeMs: number | null = null
let loadInFlight: Promise<LlamaCppConfig> | null = null
let warned = false

/**
 * M-LLAMACPP-WATCHDOG Phase 3-6：偵測 llamacpp.json 的 mtime；若已 cached
 * 而磁碟上的 mtime 比 cache 新，視為 stale → 失效 cache 觸發重讀。
 * 沒檔（mtime 取不到）保持 cache。
 */
function isCacheStale(): boolean {
  if (cached === null || cachedMtimeMs === null) return true
  try {
    const m = statSync(getLlamaCppConfigPath()).mtimeMs
    return m > cachedMtimeMs
  } catch {
    return false
  }
}

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
    parsed = parseJsonc(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSONC 解析失敗：${e instanceof Error ? e.message : String(e)}`,
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
  if (cached && !isCacheStale()) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(cfg => {
    cached = cfg
    try {
      cachedMtimeMs = statSync(getLlamaCppConfigPath()).mtimeMs
    } catch {
      cachedMtimeMs = null
    }
    loadInFlight = null
    return cfg
  })
  return loadInFlight
}

export function getLlamaCppConfigSnapshot(): LlamaCppConfig {
  // M-LLAMACPP-WATCHDOG Phase 3-6：mtime 偵測 hot-reload
  if (cached && !isCacheStale()) return cached
  // setup.ts 的 fire-and-forget 載入可能還沒跑完，同步讀檔避免拿到錯誤的預設值
  try {
    const path = getLlamaCppConfigPath()
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseJsonc(raw.replace(/^﻿/, ''))
    const result = LlamaCppConfigSchema.safeParse(parsed)
    if (result.success) {
      cached = result.data
      try {
        cachedMtimeMs = statSync(path).mtimeMs
      } catch {
        cachedMtimeMs = null
      }
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

/**
 * M-LLAMACPP-WATCHDOG：取得「實際生效」的 watchdog 設定。
 *
 * 優先序（高 → 低）：
 *   1. LLAMACPP_WATCHDOG_DISABLE=1   一鍵全關（debug；最高優先）
 *   2. LLAMACPP_WATCHDOG_ENABLE=1    一鍵全開（quick test；無視 config）
 *   3. ~/.my-agent/llamacpp.json 的 watchdog 區塊
 *   4. DEFAULT_LLAMACPP_CONFIG.watchdog（全 false）
 *
 * 回傳結構與 schema 一致；caller（adapter / TUI）直接用 master + 各層 enabled
 * 雙層 AND 判斷實際是否啟用。
 */
export function getEffectiveWatchdogConfig(): import('./schema.js').LlamaCppWatchdogConfig {
  if (process.env.LLAMACPP_WATCHDOG_DISABLE === '1') {
    return {
      enabled: false,
      interChunk: { enabled: false, gapMs: 30_000 },
      reasoning: { enabled: false, blockMs: 120_000 },
      tokenCap: {
        enabled: false,
        default: 16_000,
        memoryPrefetch: 256,
        sideQuery: 1_024,
        background: 4_000,
      },
    }
  }
  const cfg = getLlamaCppConfigSnapshot().watchdog
  if (process.env.LLAMACPP_WATCHDOG_ENABLE === '1') {
    return {
      enabled: true,
      interChunk: { ...cfg.interChunk, enabled: true },
      reasoning: { ...cfg.reasoning, enabled: true },
      tokenCap: { ...cfg.tokenCap, enabled: true },
    }
  }
  return cfg
}

/**
 * M-LLAMACPP-REMOTE：根據 callsite 解析最終 endpoint。
 *
 * - routing 缺欄位 = 'local'（schema default）
 * - 指 'remote' 但 remote.enabled=false → throw 顯式錯誤（hard-fail，避免 silent fallback）
 * - 回傳的 contextSize 給 watchdog token-cap 與 auto-compact 用
 *
 * 每個 callsite 呼叫者 per-call 呼叫此 helper，下個 turn 立刻吃 routing 變更。
 */
export type ResolvedLlamaCppEndpoint = {
  target: LlamaCppRoutingTarget
  baseUrl: string
  model: string
  apiKey?: string
  contextSize: number
}

export function resolveEndpoint(
  callSite: LlamaCppCallSite,
): ResolvedLlamaCppEndpoint {
  const cfg = getLlamaCppConfigSnapshot()
  const target: LlamaCppRoutingTarget = cfg.routing[callSite] ?? 'local'
  if (target === 'remote') {
    if (!cfg.remote.enabled) {
      throw new Error(
        `[llamacpp routing=${callSite}→remote] remote endpoint not enabled in llamacpp.jsonc; set remote.enabled=true or change routing.${callSite} to 'local'`,
      )
    }
    return {
      target: 'remote',
      baseUrl: cfg.remote.baseUrl,
      model: cfg.remote.model,
      apiKey: cfg.remote.apiKey,
      contextSize: cfg.remote.contextSize,
    }
  }
  return {
    target: 'local',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    contextSize: cfg.contextSize,
  }
}

export function _resetLlamaCppConfigForTests(): void {
  cached = null
  cachedMtimeMs = null
  loadInFlight = null
  warned = false
}
