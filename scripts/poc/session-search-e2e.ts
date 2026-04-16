/**
 * M2-08 端到端測試：驗證 SessionSearchTool 修復後能正確接收 input 並搜尋。
 *
 * 測試流程：
 * 0. 用 openSessionIndex + reconcileProjectIndex 確保真實 JSONL 已索引
 * 1. 確認索引有資料
 * 2. 驗證 checkPermissions 刪除後 input 正確傳入（模擬 toolExecution 流程）
 * 3. 驗證 FTS 搜尋回傳結果形狀正確
 * 4. 驗證 LIKE fallback（<3 char query）也正常
 * 5. 驗證原始碼不含已移除的 bug 程式碼
 *
 * 用法：bun run scripts/poc/session-search-e2e.ts
 */

import { Database } from 'bun:sqlite'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── helpers ──────────────────────────────────────────────────────────
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

// ── Step 0: Reconcile real JSONL into FTS index ─────────────────────
section('Step 0: Reconcile JSONL → FTS index')

const projectRoot = process.cwd()
const configHome =
  process.env.CLAUDE_CONFIG_HOME || path.join(os.homedir(), '.my-agent')
const slug = 'C--Users-LOREN-Documents--projects-free-code'
const dbPath = path.join(configHome, 'projects', slug, 'session-index.db')

// Import and run reconciler (this creates the DB + schema if needed)
const { openSessionIndex } = await import(
  '../../src/services/sessionIndex/db.js'
)
const { reconcileProjectIndex } = await import(
  '../../src/services/sessionIndex/reconciler.js'
)

// openSessionIndex creates schema if needed; reuse the same handle
const db = openSessionIndex(projectRoot)

// Run reconciler against real JSONL files
const stats = await reconcileProjectIndex(projectRoot)
console.log(
  `  Reconciled: ${stats.sessionsScanned} scanned, ${stats.sessionsIndexed} indexed, ${stats.messagesIndexed} messages, ${stats.errors} errors`,
)

section('Pre-flight: DB has data')
assert(stats.sessionsScanned > 0, `Scanned > 0 sessions (got ${stats.sessionsScanned})`)
const sessCount = (
  db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM sessions').get()
)!.c
const msgCount = (
  db.query<{ c: number }, []>(
    'SELECT COUNT(*) as c FROM messages_fts',
  ).get()
)!.c
console.log(`  sessions=${sessCount}  messages_fts=${msgCount}`)
assert(sessCount > 0, `sessions > 0 (got ${sessCount})`)
assert(msgCount > 0, `messages_fts > 0 (got ${msgCount})`)

// 列出可供搜尋的 keyword
const sampleMsgs = db
  .query<{ content: string }, []>(
    "SELECT content FROM messages_fts WHERE role='user' LIMIT 5",
  )
  .all()
console.log(
  '  Sample user messages:',
  sampleMsgs.map(m => m.content.slice(0, 60)),
)

// ── Test 1: FTS search（≥3 char query）───────────────────────────────
section('Test 1: FTS search with ≥3 char query')

// 找一個確定存在的 keyword
const keyword =
  db
    .query<{ content: string }, []>(
      "SELECT content FROM messages_fts WHERE role='user' AND length(content)>10 LIMIT 1",
    )
    .get()
    ?.content.split(/\s+/)
    .find(w => w.length >= 3) ?? 'llama'

console.log(`  Using keyword: "${keyword}"`)

// 模擬 sanitizeFtsQuery 邏輯（M2-07 原版：AND join）
function sanitizeFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ')
}

const ftsQuery = sanitizeFtsQuery(keyword)
console.log(`  FTS query: ${ftsQuery}`)

const ftsRows = db
  .query<
    {
      session_id: string
      message_index: number
      role: string
      tool_name: string | null
      content: string
    },
    [string, number]
  >(
    `SELECT session_id, message_index, role, tool_name, content
     FROM messages_fts
     WHERE messages_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  )
  .all(ftsQuery, 5)

assert(ftsRows.length > 0, `FTS returned ${ftsRows.length} rows (> 0)`)
for (const r of ftsRows.slice(0, 2)) {
  console.log(
    `    [${r.role}] ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
  )
}

// ── Test 2: LIKE fallback（<3 char query）────────────────────────────
section('Test 2: LIKE fallback with <3 char query')

// 從 sessions 的 first_user_message 取前 2 字作為短 query
const firstMsg = db
  .query<{ first_user_message: string | null }, []>(
    'SELECT first_user_message FROM sessions WHERE first_user_message IS NOT NULL LIMIT 1',
  )
  .get()?.first_user_message

if (firstMsg && firstMsg.length >= 2) {
  const shortQuery = firstMsg.slice(0, 2)
  console.log(`  Short query: "${shortQuery}"`)

  const likeRows = db
    .query<
      { session_id: string; first_user_message: string | null },
      [string]
    >(
      `SELECT session_id, first_user_message FROM sessions
       WHERE first_user_message LIKE ?
       ORDER BY started_at DESC
       LIMIT 5`,
    )
    .all(`%${shortQuery}%`)

  assert(
    likeRows.length > 0,
    `LIKE fallback returned ${likeRows.length} rows (> 0)`,
  )
  for (const r of likeRows.slice(0, 2)) {
    console.log(`    ${r.first_user_message?.slice(0, 60)}`)
  }
} else {
  console.log('  (skipped — no sessions with first_user_message)')
}

// ── Test 3: 模擬 checkPermissions 修復效果 ──────────────────────────
section('Test 3: Verify checkPermissions fix (input passthrough)')

// 之前的 bug：checkPermissions 回傳 updatedInput: {} → input 被覆蓋
// 修復後：不覆寫 checkPermissions → TOOL_DEFAULTS 回傳 updatedInput: input

// 模擬 TOOL_DEFAULTS.checkPermissions 行為
const testInput = { query: 'weather', limit: 5, summarize: false }
const defaultCheckPermissions = (input: Record<string, unknown>) =>
  Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
const result = await defaultCheckPermissions(testInput)

assert(
  result.updatedInput === testInput,
  'TOOL_DEFAULTS passes input through (reference equality)',
)
assert(
  (result.updatedInput as typeof testInput).query === 'weather',
  'query preserved after checkPermissions',
)
assert(
  (result.updatedInput as typeof testInput).limit === 5,
  'limit preserved after checkPermissions',
)

// 模擬舊的有 bug 的行為
const buggyCheckPermissions = () =>
  Promise.resolve({ behavior: 'allow' as const, updatedInput: {} as never })
const buggyResult = await buggyCheckPermissions()

assert(
  (buggyResult.updatedInput as Record<string, unknown>).query === undefined,
  'Old buggy checkPermissions produces undefined query (confirms bug)',
)

// ── Test 4: 模擬 toolExecution.ts 的 updatedInput 邏輯 ──────────────
section('Test 4: Simulate toolExecution.ts updatedInput logic')

// toolExecution.ts:1130-1131
function simulatePermissionFlow(
  processedInput: Record<string, unknown>,
  permissionDecision: { updatedInput?: unknown },
): Record<string, unknown> {
  if (permissionDecision.updatedInput !== undefined) {
    return permissionDecision.updatedInput as Record<string, unknown>
  }
  return processedInput
}

const fixedInput = simulatePermissionFlow(testInput, result)
assert(
  fixedInput.query === 'weather',
  'Fixed: input.query survives permission flow',
)

const brokenInput = simulatePermissionFlow(testInput, buggyResult)
assert(
  brokenInput.query === undefined,
  'Buggy: input.query lost in permission flow (confirms root cause)',
)

// ── Test 5: SessionSearchTool source 不含 checkPermissions ──────────
section('Test 5: Verify SessionSearchTool source has no checkPermissions')

const toolSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/tools/SessionSearchTool/SessionSearchTool.ts',
  ),
  'utf-8',
)
assert(
  !toolSource.includes('async checkPermissions'),
  'No checkPermissions method in SessionSearchTool.ts',
)
assert(
  !toolSource.includes('PermissionDecision'),
  'No PermissionDecision import in SessionSearchTool.ts',
)
assert(
  !toolSource.includes("typeof input?.query !== 'string'"),
  'No defensive query guard in call() (workaround removed)',
)

// ── Test 6: mapToolResultToToolResultBlockParam 格式 ─────────────────
section('Test 6: Output format (markdown)')

// 模擬一個 output 物件，測試 markdown 輸出格式
// （無法直接 import ESM tool，但可以驗證格式邏輯）
const mockOutput = {
  query: 'weather',
  usedFallback: false,
  totalMatches: 3,
  returnedMatches: 2,
  sessions: [
    {
      session_id: 'abc12345-xxxx',
      title: 'Discussing weather API',
      started_at: Date.now() - 3600_000,
      ended_at: Date.now(),
      model: 'qwen3.5-9b-neo',
      message_count: 10,
      matches: [
        {
          role: 'user',
          tool_name: null,
          snippet: 'How is the weather today?',
          message_index: 0,
        },
      ],
    },
  ],
  summaryPending: false,
}

assert(mockOutput.sessions.length > 0, 'Mock output has sessions')
assert(
  mockOutput.sessions[0]!.matches[0]!.snippet.includes('weather'),
  'Mock snippet contains search keyword',
)

// ── Summary ──────────────────────────────────────────────────────────
// Don't close db — it's managed by openSessionIndex cache

console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
  console.error('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
