import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getLlamaCppConfigSnapshot } from '../../llamacppConfig/index.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'llamacpp'

export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.MY_AGENT_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.MY_AGENT_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.MY_AGENT_USE_FOUNDRY)) return 'foundry'
  if (isEnvTruthy(process.env.MY_AGENT_USE_OPENAI)) return 'openai'
  // my-agent: 預設強制走 llamacpp（不再回 'firstParty'）。
  return 'llamacpp'
}

/**
 * 預設連到 scripts/llama/serve.sh 啟動的本地 llama.cpp server。
 * M-LLAMA-CFG：優先讀 ~/.my-agent/llamacpp.json 的 baseUrl，缺則用硬編碼預設。
 */
export const DEFAULT_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1'

/**
 * 與 scripts/llama/serve.sh 的 --alias 一致。
 * M-LLAMA-CFG：優先讀 config.model，缺則用此 fallback。
 */
export const DEFAULT_LLAMACPP_MODEL = 'qwen3.5-9b-neo'

/**
 * 已知對應到本地 llama.cpp server 的模型別名 / ID。
 * 呼叫 `--model <alias>` 時會自動啟用 llamacpp 分支，使用者不需另外
 * 設 MY_AGENT_USE_LLAMACPP=true。
 * M-LLAMA-CFG：優先讀 config.modelAliases，缺則用此 fallback。
 */
const LLAMACPP_MODEL_ALIASES_FALLBACK: readonly string[] = [
  'qwen3.5-9b-neo',
  'qwopus3.5-9b-v3',
]

/** 同步取當前有效的 alias 清單（config 優先，fallback 其次）。 */
export function getLlamaCppModelAliases(): readonly string[] {
  const cfg = getLlamaCppConfigSnapshot()
  return cfg.modelAliases.length > 0
    ? cfg.modelAliases
    : LLAMACPP_MODEL_ALIASES_FALLBACK
}

/** @deprecated use getLlamaCppModelAliases() — const 形式無法反映 config 檔 */
export const LLAMACPP_MODEL_ALIASES = LLAMACPP_MODEL_ALIASES_FALLBACK

export function isLlamaCppModel(model: string | undefined | null): boolean {
  if (!model) return false
  return getLlamaCppModelAliases().includes(model)
}

/**
 * 快速判斷：本次 session 是否走 llama.cpp 路徑。
 * 只看 env flag（`MY_AGENT_USE_LLAMACPP`），因此在使用者只下
 * `--model qwen3.5-9b-neo` 而沒設 env flag 的情境下仍會回 false —
 * 那時 banner 會顯示一般 billing，但模型名本身就足以表明路徑。
 */
export function isLlamaCppActive(): boolean {
  return getAPIProvider() === 'llamacpp'
}

/**
 * 當 provider 為 llamacpp 時回傳連線設定，否則 null。
 * base URL / model 可分別用 LLAMA_BASE_URL、LLAMA_MODEL 覆蓋。
 *
 * 偵測條件（任一成立即回非 null）：
 *   1. `MY_AGENT_USE_LLAMACPP=true`（顯式 flag）
 *   2. 傳入的 `model` 符合 LLAMACPP_MODEL_ALIASES（模型名觸發）
 */
/**
 * 當 provider 為 llamacpp 時回傳連線設定，否則 null。
 *
 * 優先序（先命中者勝）：
 *   1. env var（LLAMA_BASE_URL / LLAMA_MODEL）
 *   2. ~/.my-agent/llamacpp.json 的 baseUrl / model
 *   3. 使用者傳入的 --model 參數（若命中 alias）
 *   4. 硬編碼 DEFAULT_*
 *
 * 偵測條件（任一成立即回非 null）：
 *   1. `MY_AGENT_USE_LLAMACPP=true`（顯式 flag）
 *   2. 傳入的 `model` 符合 config.modelAliases（模型名觸發）
 */
export function getLlamaCppConfig(
  model?: string | null,
): { baseUrl: string; model: string; vision: boolean } | null {
  const envActivated = getAPIProvider() === 'llamacpp'
  const modelActivated = isLlamaCppModel(model)
  if (!envActivated && !modelActivated) return null
  const cfg = getLlamaCppConfigSnapshot()
  return {
    baseUrl:
      process.env.LLAMA_BASE_URL || cfg.baseUrl || DEFAULT_LLAMACPP_BASE_URL,
    model:
      process.env.LLAMA_MODEL ||
      (modelActivated ? (model as string) : cfg.model || DEFAULT_LLAMACPP_MODEL),
    // M-VISION: 由 `~/.my-agent/llamacpp.json` 的 `vision.enabled` 宣告
    vision: cfg.vision.enabled,
  }
}

// ── llamacpp context size 偵測 ─────────────────────────────────────────
// getContextWindowForModel() 是同步的，所以分成：
//   1. queryLlamaCppContextSize() — async，啟動時呼叫一次快取
//   2. getLlamaCppContextSize()   — sync，回傳快取值

let _cachedLlamaCppCtxSize: number | null = null

/**
 * 查詢 llama-server 的 `/slots` 端點取得實際 `--ctx-size` 值。
 * 結果快取在 module scope，後續 `getLlamaCppContextSize()` 同步讀取。
 * 3 秒 timeout — server 未啟動時不阻塞。
 */
let _warnedLlamaCppCtxSizeMissing = false

export async function queryLlamaCppContextSize(
  baseUrl?: string,
): Promise<number | null> {
  if (_cachedLlamaCppCtxSize !== null) return _cachedLlamaCppCtxSize
  const root = (baseUrl || DEFAULT_LLAMACPP_BASE_URL).replace(/\/v1\/?$/, '')
  try {
    const res = await globalThis.fetch(`${root}/slots`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      warnOnceCtxSizeMissing(
        `llama-server /slots HTTP ${res.status}; 若模型非 200K 請設 LLAMACPP_CTX_SIZE=<tokens>`,
      )
      return null
    }
    const slots = (await res.json()) as Array<{ n_ctx?: number }>
    const n_ctx = slots?.[0]?.n_ctx
    if (typeof n_ctx === 'number' && n_ctx > 0) {
      _cachedLlamaCppCtxSize = n_ctx
      return n_ctx
    }
    warnOnceCtxSizeMissing(
      `llama-server /slots 未回傳 n_ctx；若模型非 200K 請設 LLAMACPP_CTX_SIZE=<tokens>`,
    )
  } catch (e) {
    warnOnceCtxSizeMissing(
      `llama-server /slots 查詢失敗（${e instanceof Error ? e.message : String(e)}）；若模型非 200K 請設 LLAMACPP_CTX_SIZE=<tokens>，否則 auto-compact 閾值會落在 200K 造成溢出`,
    )
  }
  return null
}

function warnOnceCtxSizeMissing(reason: string): void {
  if (_warnedLlamaCppCtxSizeMissing) return
  _warnedLlamaCppCtxSizeMissing = true
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(`[llamacpp] ${reason}`)
}

/**
 * 同步回傳 `queryLlamaCppContextSize()` 的快取結果。
 * 尚未查詢過或查詢失敗時回 null。
 */
export function getLlamaCppContextSize(): number | null {
  return _cachedLlamaCppCtxSize
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
