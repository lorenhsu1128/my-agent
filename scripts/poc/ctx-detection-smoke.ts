/**
 * 驗證 llama.cpp context window 偵測 — 確認 /slots 查詢 + getContextWindowForModel 正確
 */
import { queryLlamaCppContextSize, getLlamaCppContextSize, DEFAULT_LLAMACPP_BASE_URL } from '../../src/utils/model/providers.js'

// 強制啟用 llamacpp provider
process.env.CLAUDE_CODE_USE_LLAMACPP = 'true'

const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getAutoCompactThreshold, getEffectiveContextWindowSize } = await import('../../src/services/compact/autoCompact.js')

let passed = 0
let failed = 0
function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

console.log('=== Context Window 偵測 Smoke Test ===\n')

// 1. 查詢前，同步版回 null
console.log('Gate 1: 查詢前快取為空')
assert('getLlamaCppContextSize() 初始為 null', getLlamaCppContextSize() === null)

// 2. 查詢 /slots
console.log('\nGate 2: queryLlamaCppContextSize()')
const n_ctx = await queryLlamaCppContextSize(DEFAULT_LLAMACPP_BASE_URL)
console.log(`  查到 n_ctx = ${n_ctx}`)
assert('查詢回傳有效數值', typeof n_ctx === 'number' && n_ctx > 0)
assert('快取已更新', getLlamaCppContextSize() === n_ctx)

// 3. getContextWindowForModel 回傳 /slots 值而非 200K
console.log('\nGate 3: getContextWindowForModel() 走 llamacpp 分支')
const ctxWindow = getContextWindowForModel('qwopus3.5-9b-v3')
console.log(`  getContextWindowForModel = ${ctxWindow}`)
assert('回傳 /slots 查到的值', ctxWindow === n_ctx)
assert('不是 200K fallback', ctxWindow !== 200_000)

// 4. autocompact 閾值計算
console.log('\nGate 4: autocompact 閾值')
const effective = getEffectiveContextWindowSize('qwopus3.5-9b-v3')
const threshold = getAutoCompactThreshold('qwopus3.5-9b-v3')
console.log(`  effectiveWindow = ${effective}  (ctxWindow - 20000 output reserve)`)
console.log(`  autoCompactThreshold = ${threshold}  (effective - 13000 buffer)`)
assert('effectiveWindow < 200K', effective < 200_000)
assert('threshold < 100K', threshold < 100_000, `got ${threshold}`)
assert('threshold ≈ ctxWindow - 33000', Math.abs(threshold - (ctxWindow! - 33_000)) < 1000, `got ${threshold}`)

// 5. 結果
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
