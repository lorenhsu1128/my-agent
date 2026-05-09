/**
 * M-TCQ-SHIM-SAMPLER：preset 注入純函式。
 *
 * 設計重點：
 * - Family gate：preset.appliesTo glob 對 modelId 比對，沒命中就靜默跳過（正常路徑）
 * - 注入規則：只填 body 還沒帶的欄位（caller 顯式 > preset）
 * - 未知 taskType key → console.warn 並回原 body（不 fail-hard 避免拼錯炸整段）
 *
 * 純函式 + 無 side effect（除 warn log），方便整合測試。
 */
import type { LlamaCppConfig, SamplingParams, SamplingPreset } from './schema.ts'

/**
 * Glob 比對：支援 `*` 為任意字元（含空字串）。大小寫不敏感。
 *   matchesPattern('qwen3.5-9b-neo', 'qwen*')   → true
 *   matchesPattern('claude-sonnet', '*qwen*')    → false
 *   matchesPattern('llama-3.1-8b', 'llama-3*')   → true
 */
export function matchesPattern(modelId: string, pattern: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return re.test(modelId.toLowerCase())
}

export function presetAppliesToModel(preset: SamplingPreset, modelId: string): boolean {
  return preset.appliesTo.some((p) => matchesPattern(modelId, p))
}

/**
 * 把 preset 的欄位填進 OpenAI body（只填 body 缺的欄位）。
 *
 * 回傳新物件，不 mutate 輸入。
 */
export function applyPresetParams(
  body: Record<string, unknown>,
  params: SamplingParams,
): Record<string, unknown> {
  const out = { ...body }
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (out[key] == null) out[key] = value
  }
  return out
}

/**
 * 主入口：依 taskType / defaultSamplingPreset / family gate 注入 sampling 欄位。
 *
 * @param body  已組好的 OpenAI request body（含 model / messages / 既有 sampling 欄位）
 * @param config llamacpp 設定（取 samplingPresets / defaultSamplingPreset）
 * @param taskType caller 透過 Anthropic metadata.taskType 帶入；可為 undefined
 *
 * @returns 注入後的新 body（若無命中則回原 body shallow copy）
 */
export function applySamplingPreset(
  body: Record<string, unknown>,
  config: Pick<LlamaCppConfig, 'samplingPresets' | 'defaultSamplingPreset'>,
  taskType: string | undefined,
): Record<string, unknown> {
  const modelId = typeof body.model === 'string' ? body.model : ''
  if (modelId === '') return { ...body }

  const presetKey = taskType ?? config.defaultSamplingPreset
  if (presetKey == null || presetKey === '') return { ...body }

  const preset = config.samplingPresets[presetKey]
  if (preset == null) {
    // 未知 key — warn 但不 fail
    console.warn(
      `[llamacpp] samplingPreset '${presetKey}' not found in config.samplingPresets; available: ${Object.keys(config.samplingPresets).join(', ')}`,
    )
    return { ...body }
  }

  // Family gate — 不命中靜默跳過（正常路徑）
  if (!presetAppliesToModel(preset, modelId)) return { ...body }

  return applyPresetParams(body, preset.params)
}
