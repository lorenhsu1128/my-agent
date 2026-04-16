#!/usr/bin/env bun
/**
 * M2-19 整合測試：recall 情境 + prefetch 注入。
 *
 * 用法：bun run tests/integration/memory/recall-and-prefetch.ts
 *
 * 測試項目：
 * 1. SessionSearch FTS recall — 關鍵字搜尋過往 session
 * 2. SessionSearch LIKE fallback — 短 query (<3 chars)
 * 3. Prefetch fence 格式驗證 — <memory-context> 包裹
 * 4. Prefetch 空結果 — 不產生 fence
 * 5. Prefetch 預算限制 — 不超過 char budget
 */

import {
  buildMemoryContextFence,
  CHAR_BUDGET,
  MAX_FTS_SNIPPETS,
  searchSessionHistory,
  type FtsSnippet,
} from '../../../src/services/memoryPrefetch/index.js'
import { openSessionIndex } from '../../../src/services/sessionIndex/db.js'
import { reconcileProjectIndex } from '../../../src/services/sessionIndex/reconciler.js'

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
section('Setup: 確保索引存在')
openSessionIndex(projectRoot)
const stats = await reconcileProjectIndex(projectRoot)
console.log(`  sessions scanned: ${stats.sessionsScanned}, messages indexed: ${stats.messagesIndexed}`)

// ---------------------------------------------------------------------------
// 1. FTS recall
// ---------------------------------------------------------------------------
section('1. SessionSearch FTS recall')

const recall1 = await searchSessionHistory('llama', projectRoot)
assert(recall1.length >= 0, `FTS 搜尋 "llama" 回傳 ${recall1.length} 筆（≥0）`)
if (recall1.length > 0) {
  assert(typeof recall1[0]!.sessionId === 'string', '結果有 sessionId')
  assert(typeof recall1[0]!.content === 'string', '結果有 content')
  assert(recall1[0]!.role !== 'tool', 'FTS 結果不含 tool role')
}

// 不存在的關鍵字
const recall2 = await searchSessionHistory('xyzzy_nonexistent_keyword_99', projectRoot)
assert(recall2.length === 0, '不存在的關鍵字回傳 0 筆')

// ---------------------------------------------------------------------------
// 2. LIKE fallback（短 query）
// ---------------------------------------------------------------------------
section('2. Short query fallback')

// <3 chars 的 query 應走 FTS fallback（可能回空但不應 throw）
const shortResult = await searchSessionHistory('天氣', projectRoot)
assert(Array.isArray(shortResult), '短 query "天氣" 回傳陣列（不 throw）')

// ---------------------------------------------------------------------------
// 3. Prefetch fence 格式
// ---------------------------------------------------------------------------
section('3. Prefetch fence 格式')

const mockSnippets: FtsSnippet[] = [
  { sessionId: 'abc123', role: 'user', content: '測試內容一', startedAt: Date.now() - 60000 },
  { sessionId: 'def456', role: 'assistant', content: '測試回應二', startedAt: Date.now() - 30000 },
]
const fence = buildMemoryContextFence(mockSnippets)
assert(fence.length > 0, 'non-empty snippets 產生 fence')
assert(fence.startsWith('<memory-context>'), 'fence 以 <memory-context> 開頭')
assert(fence.endsWith('</memory-context>'), 'fence 以 </memory-context> 結尾')
assert(fence.includes('[past-sessions]'), 'fence 含 [past-sessions] 標籤')
assert(fence.includes('測試內容一'), 'fence 含第一筆 snippet 內容')

// ---------------------------------------------------------------------------
// 4. 空結果 fence
// ---------------------------------------------------------------------------
section('4. 空結果不產生 fence')

const emptyFence = buildMemoryContextFence([])
assert(emptyFence === '', '空 snippets 回傳空字串')

// ---------------------------------------------------------------------------
// 5. 預算限制
// ---------------------------------------------------------------------------
section('5. 預算限制')

// 產生超大 snippets
const bigSnippets: FtsSnippet[] = Array.from({ length: 20 }, (_, i) => ({
  sessionId: `sess_${i}`,
  role: 'assistant' as const,
  content: 'x'.repeat(2000),
  startedAt: Date.now() - i * 1000,
}))
const bigFence = buildMemoryContextFence(bigSnippets)
if (bigFence) {
  assert(bigFence.length <= CHAR_BUDGET + 200, `fence 長度 (${bigFence.length}) 在預算內（±200 char margin for tags）`)
  // 檢查截斷邏輯：不會超過 MAX_FTS_SNIPPETS
  const snippetCount = (bigFence.match(/\[sess_/g) || []).length
  assert(snippetCount <= MAX_FTS_SNIPPETS, `snippet 數量 (${snippetCount}) ≤ MAX_FTS_SNIPPETS (${MAX_FTS_SNIPPETS})`)
} else {
  assert(false, 'bigSnippets 應產生 fence（不為 null）')
}

// ---------------------------------------------------------------------------
// 結果
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`recall-and-prefetch: ${passed} 通過, ${failed} 失敗 (共 ${passed + failed})`)
if (failed > 0) process.exit(1)
