/**
 * 驗證 llama.cpp ctx size 解析的優先序。
 *
 * 透過 real module + env var 控制而非 mock.module，避免 bun:test 跨檔 mock 洩漏。
 *
 * 優先序鏈（getContextWindowForModel）：
 *   1. /slots 實際 n_ctx（getLlamaCppContextSize 回傳數字）
 *   2. LLAMACPP_CTX_SIZE env var
 *   3. getGlobalConfig().contextSize（.my-agent.json）
 *   4. getLlamaCppConfigSnapshot().contextSize（llamacpp.json）
 *   5. MODEL_CONTEXT_WINDOW_DEFAULT（128K 硬編）
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const originalEnv = {
  LLAMACPP_CTX_SIZE: process.env.LLAMACPP_CTX_SIZE,
  MY_AGENT_MAX_CONTEXT_TOKENS: process.env.MY_AGENT_MAX_CONTEXT_TOKENS,
  USER_TYPE: process.env.USER_TYPE,
  MY_AGENT_USE_LLAMACPP: process.env.MY_AGENT_USE_LLAMACPP,
}

beforeEach(() => {
  delete process.env.LLAMACPP_CTX_SIZE
  delete process.env.MY_AGENT_MAX_CONTEXT_TOKENS
  delete process.env.USER_TYPE
  // 強制走 llamacpp 分支
  process.env.MY_AGENT_USE_LLAMACPP = '1'
})

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const { getContextWindowForModel, MODEL_CONTEXT_WINDOW_DEFAULT } = await import(
  '../../../src/utils/context.js'
)

describe('MODEL_CONTEXT_WINDOW_DEFAULT', () => {
  test('是 131_072 (128K)', () => {
    expect(MODEL_CONTEXT_WINDOW_DEFAULT).toBe(131_072)
  })
})

describe('getContextWindowForModel — llamacpp 優先序', () => {
  test('env LLAMACPP_CTX_SIZE 存在 → 使用 env 值', () => {
    process.env.LLAMACPP_CTX_SIZE = '99999'
    // 用非標準 model 名避免 capability lookup 截斷
    const result = getContextWindowForModel('qwen3.5-9b-neo')
    expect(result).toBe(99999)
  })

  test('env 為 0 → 跳過該層，fallback 到下一層（不會回 0）', () => {
    process.env.LLAMACPP_CTX_SIZE = '0'
    const result = getContextWindowForModel('qwen3.5-9b-neo')
    // 實際 /slots / globalConfig / llamacpp.json 至少一層會給 128K
    expect(result).toBeGreaterThan(0)
    expect(result).toBeGreaterThanOrEqual(131072)
  })

  test('env 為非數字 → 跳過該層', () => {
    process.env.LLAMACPP_CTX_SIZE = 'abc'
    const result = getContextWindowForModel('qwen3.5-9b-neo')
    expect(result).toBeGreaterThanOrEqual(131072)
  })

  test('env 為負數 → 跳過該層', () => {
    process.env.LLAMACPP_CTX_SIZE = '-100'
    const result = getContextWindowForModel('qwen3.5-9b-neo')
    expect(result).toBeGreaterThanOrEqual(131072)
  })

  test('無 env → fallback 到 globalConfig / llamacpp.json 的預設值（128K）', () => {
    const result = getContextWindowForModel('qwen3.5-9b-neo')
    // 預設 GlobalConfig.contextSize = 131072 或 llamacpp.json.contextSize = 131072
    expect(result).toBe(131072)
  })
})
