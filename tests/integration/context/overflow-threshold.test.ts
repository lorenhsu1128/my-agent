/**
 * 驗證「上下文超過長度」的偵測時機：
 *   - 新預設 128K 下，auto-compact 閾值 ≈ 81K（128K - 20K summary - 30K llamacpp buffer）
 *   - 舊 200K 下閾值 ≈ 150K（會錯過 100K 已超出 128K 上限的情境）
 *   - 100K tokens 的 session：舊行為 NOT trigger、新行為 trigger
 *
 * 透過 LLAMACPP_CTX_SIZE env var 控制 ctx window（優先序層 2），
 * 直接呼 getAutoCompactThreshold / calculateTokenWarningState，不跑整個 query loop。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

function setCtx(n: number): void {
  process.env.LLAMACPP_CTX_SIZE = String(n)
}

const originalEnv = process.env.LLAMACPP_CTX_SIZE

beforeEach(() => {
  delete process.env.LLAMACPP_CTX_SIZE
  delete process.env.LLAMACPP_COMPACT_BUFFER
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.LLAMACPP_CTX_SIZE
  else process.env.LLAMACPP_CTX_SIZE = originalEnv
})

const { getAutoCompactThreshold, calculateTokenWarningState } = await import(
  '../../../src/services/compact/autoCompact.js'
)

describe('getAutoCompactThreshold — llamacpp 模型 buffer=30K', () => {
  const model = 'qwen3.5-9b-neo'

  // 公式：threshold = ctx - reservedForSummary (≤20K) - llamacppBuffer (30K)
  // 實測 qwen3.5-9b-neo：reserved=8000（capped max_output），buffer=30000
  test('128K ctx → threshold ≈ 93K', () => {
    setCtx(131072)
    const t = getAutoCompactThreshold(model)
    expect(t).toBeGreaterThan(80000)
    expect(t).toBeLessThan(100000)
  })

  test('200K ctx → threshold ≈ 162K（舊行為對比）', () => {
    setCtx(200000)
    const t = getAutoCompactThreshold(model)
    expect(t).toBeGreaterThan(155000)
    expect(t).toBeLessThan(170000)
  })

  test('64K ctx → threshold ≈ 27K', () => {
    setCtx(65536)
    const t = getAutoCompactThreshold(model)
    expect(t).toBeGreaterThan(20000)
    expect(t).toBeLessThan(35000)
  })
})

describe('calculateTokenWarningState — 100K tokens 跨 ctx 大小', () => {
  const model = 'qwen3.5-9b-neo'
  const tokens = 100_000

  test('128K ctx + 100K tokens → 超過閾值（新行為會觸發 compact）', () => {
    setCtx(131072)
    const state = calculateTokenWarningState(tokens, model)
    expect(state.isAboveAutoCompactThreshold).toBe(true)
  })

  test('200K ctx + 100K tokens → 未超過（舊行為錯過 overflow）', () => {
    setCtx(200000)
    const state = calculateTokenWarningState(tokens, model)
    expect(state.isAboveAutoCompactThreshold).toBe(false)
  })

  test('128K ctx + 50K tokens → 安全，不觸發', () => {
    setCtx(131072)
    const state = calculateTokenWarningState(50_000, model)
    expect(state.isAboveAutoCompactThreshold).toBe(false)
  })

  test('128K ctx + 130K tokens → 爆掉，當然觸發', () => {
    setCtx(131072)
    const state = calculateTokenWarningState(130_000, model)
    expect(state.isAboveAutoCompactThreshold).toBe(true)
  })
})

describe('回歸測試：用戶實際 trace 的 case', () => {
  // 用戶 trace 背景：128K 本地模型被當作 200K，auto-compact 不觸發，
  // 同時 llama.cpp 默默回 finish_reason=length 不拋錯，reactive compact 也沒吃到。
  // 新行為下 ~95K tokens 就該觸發 compact 避免溢出。
  test('95K tokens + 128K ctx → 觸發 compact', () => {
    setCtx(131072)
    const state = calculateTokenWarningState(95_000, 'qwen3.5-9b-neo')
    expect(state.isAboveAutoCompactThreshold).toBe(true)
  })

  test('/slots 查到 true 128K 時，閾值落在 81K 附近而非 150K', () => {
    setCtx(131072)
    const threshold = getAutoCompactThreshold('qwen3.5-9b-neo')
    expect(threshold).toBeLessThan(100_000) // 舊版是 150K
  })
})
