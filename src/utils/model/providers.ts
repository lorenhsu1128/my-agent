import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'llamacpp'

export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_LLAMACPP)) return 'llamacpp'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return 'openai'
  return 'firstParty'
}

/** 預設連到 scripts/llama/serve.sh 啟動的本地 llama.cpp server。 */
export const DEFAULT_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1'

/** 與 scripts/llama/serve.sh 的 --alias 一致。 */
export const DEFAULT_LLAMACPP_MODEL = 'qwen3.5-9b-neo'

/**
 * 當 provider 為 llamacpp 時回傳連線設定，否則 null。
 * base URL / model 可分別用 LLAMA_BASE_URL、LLAMA_MODEL 覆蓋。
 */
export function getLlamaCppConfig(): { baseUrl: string; model: string } | null {
  if (getAPIProvider() !== 'llamacpp') return null
  return {
    baseUrl: process.env.LLAMA_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
    model: process.env.LLAMA_MODEL || DEFAULT_LLAMACPP_MODEL,
  }
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
