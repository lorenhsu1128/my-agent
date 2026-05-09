// M-TCQ-SHIM-SAMPLER：sampling preset 注入 + family gate 測試。
//
// 涵蓋（plan B5 + B5-glob）：
// 1. Schema 解析：空 config → 4 組預設；自訂 preset 並存
// 2. adapter 注入 thinking-coding（Qwen 模型）
// 3. caller 顯式 temperature 覆蓋 preset
// 4. 未知 taskType → warn 不注入
// 5. defaultSamplingPreset fallback
// 6. 非 Qwen 模型不套用 (family gate)
// 7. matchesPattern glob 行為

import { describe, expect, test } from 'bun:test'
import {
  applySamplingPreset,
  matchesPattern,
  presetAppliesToModel,
} from '../../../src/llamacppConfig/applySamplingPreset.ts'
import {
  LlamaCppConfigSchema,
  DEFAULT_LLAMACPP_CONFIG,
  type LlamaCppConfig,
  type SamplingPreset,
} from '../../../src/llamacppConfig/schema.ts'
import { translateRequestToOpenAI } from '../../../src/services/api/llamacpp-fetch-adapter.js'

function presetCfg(
  over: Partial<Pick<LlamaCppConfig, 'samplingPresets' | 'defaultSamplingPreset'>> = {},
) {
  return {
    samplingPresets: DEFAULT_LLAMACPP_CONFIG.samplingPresets,
    defaultSamplingPreset: undefined,
    ...over,
  }
}

describe('schema：samplingPresets 預設與自訂並存', () => {
  test('空 config 解析後得到 4 組 Qwen 預設 preset', () => {
    const cfg = LlamaCppConfigSchema.parse({})
    const keys = Object.keys(cfg.samplingPresets)
    expect(keys).toContain('thinking-general')
    expect(keys).toContain('thinking-coding')
    expect(keys).toContain('instruct-general')
    expect(keys).toContain('instruct-reasoning')
    expect(cfg.samplingPresets['thinking-coding'].appliesTo).toEqual(['qwen*', '*qwen*'])
    expect(cfg.samplingPresets['thinking-coding'].params.temperature).toBe(0.6)
  })

  test('使用者自訂 preset 與預設並存', () => {
    const cfg = LlamaCppConfigSchema.parse({
      samplingPresets: {
        creative: {
          appliesTo: ['*'],
          params: { temperature: 1.2, top_p: 0.9 },
        },
      },
    })
    // record schema 是 replace 還是 merge — 預期 zod record default 在使用者覆蓋時整個 dict 被取代
    expect(cfg.samplingPresets.creative).toBeDefined()
    expect(cfg.samplingPresets.creative.params.temperature).toBe(1.2)
  })
})

describe('matchesPattern (glob)', () => {
  test('qwen* 命中 qwen3.5-9b-neo', () => {
    expect(matchesPattern('qwen3.5-9b-neo', 'qwen*')).toBe(true)
  })
  test('llama-3* 命中 llama-3.1-8b、不命中 qwen3', () => {
    expect(matchesPattern('llama-3.1-8b', 'llama-3*')).toBe(true)
    expect(matchesPattern('qwen3.5-9b', 'llama-3*')).toBe(false)
  })
  test('* 命中所有', () => {
    expect(matchesPattern('claude-sonnet-4-6', '*')).toBe(true)
  })
  test('大小寫不敏感', () => {
    expect(matchesPattern('Qwen3-32B', 'qwen*')).toBe(true)
  })
  test('*qwen* 命中內含 qwen 的 model id（如 my-qwen-finetune）', () => {
    expect(matchesPattern('my-qwen-finetune', '*qwen*')).toBe(true)
    expect(matchesPattern('claude-3-opus', '*qwen*')).toBe(false)
  })
})

describe('presetAppliesToModel (any-pattern OR)', () => {
  const preset: SamplingPreset = {
    appliesTo: ['qwen*', '*qwen*'],
    params: { temperature: 0.7 },
  }
  test('Qwen 命中', () => {
    expect(presetAppliesToModel(preset, 'qwen3.5-9b-neo')).toBe(true)
  })
  test('Claude 不命中', () => {
    expect(presetAppliesToModel(preset, 'claude-sonnet-4-6')).toBe(false)
  })
})

describe('applySamplingPreset 純函式', () => {
  test('Qwen 模型 + thinking-coding → 注入完整 5 欄位', () => {
    const out = applySamplingPreset(
      { model: 'qwen3.5-9b', messages: [] },
      presetCfg(),
      'thinking-coding',
    )
    expect(out.temperature).toBe(0.6)
    expect(out.top_p).toBe(0.95)
    expect(out.top_k).toBe(20)
    expect(out.min_p).toBe(0.0)
    expect(out.presence_penalty).toBe(0.0)
  })

  test('caller 顯式 temperature → 不被 preset 覆蓋', () => {
    const out = applySamplingPreset(
      { model: 'qwen3.5-9b', messages: [], temperature: 0.3 },
      presetCfg(),
      'thinking-coding',
    )
    expect(out.temperature).toBe(0.3)
    expect(out.top_p).toBe(0.95) // 其他欄位仍走 preset
  })

  test('未知 taskType → 印 warn 不注入', () => {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '))
    }
    try {
      const out = applySamplingPreset(
        { model: 'qwen3.5-9b', messages: [] },
        presetCfg(),
        'unknown-foo',
      )
      expect(out.temperature).toBeUndefined()
      expect(warns.some((w) => w.includes("'unknown-foo'"))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  test('defaultSamplingPreset fallback：無 metadata + Qwen → 注入 default', () => {
    const out = applySamplingPreset(
      { model: 'qwen3.5-9b', messages: [] },
      presetCfg({ defaultSamplingPreset: 'instruct-general' }),
      undefined,
    )
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.8)
  })

  test('非 Qwen 模型 + 帶 taskType → 完全不注入（family gate 不命中靜默跳過）', () => {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '))
    }
    try {
      const out = applySamplingPreset(
        { model: 'claude-sonnet-4-6', messages: [] },
        presetCfg(),
        'thinking-coding',
      )
      expect(out.temperature).toBeUndefined()
      expect(out.min_p).toBeUndefined()
      // family gate 是正常路徑，不應 warn
      expect(warns.length).toBe(0)
    } finally {
      console.warn = orig
    }
  })

  test('defaultSamplingPreset 也走 family gate：non-Qwen 不注入', () => {
    const out = applySamplingPreset(
      { model: 'claude-sonnet-4-6', messages: [] },
      presetCfg({ defaultSamplingPreset: 'instruct-general' }),
      undefined,
    )
    expect(out.temperature).toBeUndefined()
  })

  test('使用者自訂 preset appliesTo=[*]：所有模型都套用', () => {
    const cfg = presetCfg({
      samplingPresets: {
        ...DEFAULT_LLAMACPP_CONFIG.samplingPresets,
        'global-creative': {
          appliesTo: ['*'],
          params: { temperature: 1.3, top_p: 0.92 },
        },
      },
    })
    const out = applySamplingPreset(
      { model: 'claude-sonnet-4-6', messages: [] },
      cfg,
      'global-creative',
    )
    expect(out.temperature).toBe(1.3)
  })
})

describe('translateRequestToOpenAI metadata.taskType 端對端注入', () => {
  test('Qwen 模型 + metadata.taskType=instruct-general → body 帶完整 sampling', () => {
    const out = translateRequestToOpenAI(
      {
        model: 'qwen3.5-9b',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'hi' }],
        // Anthropic SDK metadata 是 free-form，taskType 是我們約定的 key
        metadata: { taskType: 'instruct-general' },
      } as unknown as Parameters<typeof translateRequestToOpenAI>[0],
      'qwen3.5-9b',
      { samplingPresetCfg: presetCfg() },
    )
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.8)
    expect(out.top_k).toBe(20)
    expect(out.min_p).toBe(0.0)
    expect(out.presence_penalty).toBe(1.5)
  })

  test('非 Qwen 模型 + metadata.taskType → 不注入', () => {
    const out = translateRequestToOpenAI(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { taskType: 'thinking-coding' },
      } as unknown as Parameters<typeof translateRequestToOpenAI>[0],
      'claude-sonnet-4-6',
      { samplingPresetCfg: presetCfg() },
    )
    expect(out.temperature).toBeUndefined()
    expect(out.min_p).toBeUndefined()
  })
})
