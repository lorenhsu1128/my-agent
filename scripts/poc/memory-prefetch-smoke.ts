/**
 * M2-09 + M2-10 smoke test：FTS 歷史搜尋 + 預算控制。
 *
 * 用法：bun run scripts/poc/memory-prefetch-smoke.ts
 */
import {
  buildMemoryContextFence,
  CHAR_BUDGET,
  MAX_FTS_SNIPPETS,
  searchSessionHistory,
  type FtsSnippet,
} from '../../src/services/memoryPrefetch/index.js'
import { openSessionIndex } from '../../src/services/sessionIndex/db.js'
import { reconcileProjectIndex } from '../../src/services/sessionIndex/reconciler.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const projectRoot = process.cwd()

// 確保索引存在且有資料
section('Setup: Reconcile index')
openSessionIndex(projectRoot)
const stats = await reconcileProjectIndex(projectRoot)
console.log(`  ${stats.sessionsScanned} sessions scanned, ${stats.messagesIndexed} messages indexed`)

// ── Test 1: 正常 FTS 搜尋 ──
section('Test 1: FTS search with valid keyword')
const results1 = await searchSessionHistory('llama', projectRoot)
console.log(`  Got ${results1.length} results`)
assert(results1.length > 0, 'llama search returns results')
if (results1.length > 0) {
  assert(typeof results1[0]!.sessionId === 'string', 'result has sessionId')
  assert(typeof results1[0]!.role === 'string', 'result has role')
  assert(typeof results1[0]!.content === 'string', 'result has content')
  assert(typeof results1[0]!.startedAt === 'number', 'result has startedAt')
  assert(results1[0]!.content.length <= 301, 'content truncated to ~300 chars')
  assert(results1[0]!.role !== 'tool', 'tool role filtered out')
}

// ── Test 2: 短 query 回空 ──
section('Test 2: Short query — 2-char CJK now uses LIKE fallback')
const results2 = await searchSessionHistory('天氣', projectRoot)
assert(Array.isArray(results2), '2-char CJK query returns array (may find via LIKE fallback)')

const results2b = await searchSessionHistory('ab', projectRoot)
assert(Array.isArray(results2b), '2-char ASCII query returns array (may find via LIKE fallback)')

const results2c = await searchSessionHistory('x', projectRoot)
assert(results2c.length === 0, '1-char query returns empty array')

// ── Test 3: 空 query ──
section('Test 3: Empty/null query')
const results3a = await searchSessionHistory('', projectRoot)
assert(results3a.length === 0, 'empty string returns empty')

const results3b = await searchSessionHistory('   ', projectRoot)
assert(results3b.length === 0, 'whitespace-only returns empty')

// ── Test 4: limit 參數 ──
section('Test 4: Custom limit')
const results4 = await searchSessionHistory('llama', projectRoot, 1)
assert(results4.length <= 1, 'limit=1 returns at most 1 result')

// ── Test 5: 中文搜尋 ──
section('Test 5: CJK search (≥3 chars)')
const results5 = await searchSessionHistory('天氣預報', projectRoot)
console.log(`  Got ${results5.length} results for 天氣預報`)
// 不 assert > 0 因為可能沒有這個 keyword，但至少不 crash
assert(Array.isArray(results5), 'CJK search returns array (no crash)')

// ── Test 6: FTS reserved chars 不 crash ──
section('Test 6: FTS reserved chars')
const results6 = await searchSessionHistory('hello.world "test"', projectRoot)
assert(Array.isArray(results6), 'reserved chars handled (no crash)')

// ── Test 7: buildMemoryContextFence 基本格式 ──
section('Test 7: buildMemoryContextFence basic format')
const fence1 = buildMemoryContextFence(results1)
assert(fence1.startsWith('<memory-context>'), 'fence starts with <memory-context>')
assert(fence1.endsWith('</memory-context>'), 'fence ends with </memory-context>')
assert(fence1.includes('[past-sessions]'), 'fence contains [past-sessions] section')
console.log(`  Fence length: ${fence1.length} chars`)

// ── Test 8: 空結果不產生 fence ──
section('Test 8: Empty results → empty string')
const fence2 = buildMemoryContextFence([])
assert(fence2 === '', 'empty snippets → empty string')

// ── Test 9: 預算截斷 ──
section('Test 9: Budget truncation')
const bigSnippets: FtsSnippet[] = Array.from({ length: 10 }, (_, i) => ({
  sessionId: `sess-${i}`,
  role: 'user',
  content: 'A'.repeat(3000), // 每筆 3000 chars，遠超預算
  startedAt: Date.now() - i * 86400_000,
}))
const fence3 = buildMemoryContextFence(bigSnippets)
assert(fence3.length <= CHAR_BUDGET + 100, `fence within budget (got ${fence3.length}, budget ${CHAR_BUDGET})`)
assert(fence3.length > 0, 'fence not empty despite truncation')
// MAX_FTS_SNIPPETS cap
const lineCount = fence3.split('\n').filter(l => l.startsWith('(')).length
assert(lineCount <= MAX_FTS_SNIPPETS, `at most ${MAX_FTS_SNIPPETS} snippet lines (got ${lineCount})`)

// ── Test 10: 真實資料的 fence ──
section('Test 10: Real data fence')
const realResults = await searchSessionHistory('llama', projectRoot, 3)
const realFence = buildMemoryContextFence(realResults)
if (realResults.length > 0) {
  assert(realFence.length > 0, 'real data produces non-empty fence')
  assert(realFence.length <= CHAR_BUDGET, `real fence within budget (${realFence.length} chars)`)
  console.log(`  Real fence:\n${realFence.slice(0, 300)}...`)
} else {
  console.log('  (skipped — no FTS results)')
}

// ── Summary ──
console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
  console.error('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
