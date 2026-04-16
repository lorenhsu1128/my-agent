/**
 * M2-09 smoke test：驗證 FTS 歷史對話搜尋模組。
 *
 * 用法：bun run scripts/poc/memory-prefetch-smoke.ts
 */
import { searchSessionHistory } from '../../src/services/memoryPrefetch/index.js'
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
section('Test 2: Short query (<3 chars) returns empty')
const results2 = await searchSessionHistory('天氣', projectRoot)
assert(results2.length === 0, '2-char query returns empty array')

const results2b = await searchSessionHistory('ab', projectRoot)
assert(results2b.length === 0, '2-char ASCII query returns empty array')

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

// ── Summary ──
console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
  console.error('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
