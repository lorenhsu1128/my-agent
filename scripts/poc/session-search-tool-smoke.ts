/**
 * Smoke test for SessionSearchTool（M2-05）。
 *
 * 跑在使用者真實 session-index.db 上（~/.my-agent/projects/{slug}/），
 * 只讀、不改。需先跑過 rebuild-session-index 或 TUI 讓 index 有資料。
 *
 * Usage: bun run scripts/poc/session-search-tool-smoke.ts
 */
// M2-06 smoke：測試 summarize fallback 需要讓 getAnthropicClient() 走到 fetch
// 但目標不可達 → 快速失敗 → 驗證 graceful fallback。
// 設在 import 之前：env 被 getClaudeConfigHomeDir / client bootstrap 讀取。
process.env.CLAUDE_CODE_USE_LLAMACPP = 'true'
process.env.LLAMA_BASE_URL = 'http://127.0.0.1:9' // 保證 ECONNREFUSED
process.env.LLAMA_MODEL = 'qwen3.5-9b-neo'

import { setOriginalCwd, setProjectRoot } from '../../src/bootstrap/state.js'

// 設定 bootstrap state，讓 Tool 內的 getProjectRoot() 有值
const projectRoot = process.cwd()
setOriginalCwd(projectRoot)
setProjectRoot(projectRoot)

const { SessionSearchTool } = await import(
  '../../src/tools/SessionSearchTool/SessionSearchTool.js'
)

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}${extra ? ` (${extra})` : ''}`)
    passed++
  } else {
    console.log(`  ✗ ${name}${extra ? ` (${extra})` : ''}`)
    failed++
  }
}

// M2-06：context 現在被 summarize 分支用 — 要 mainLoopModel + abortController
const fakeCtx = {
  options: {
    mainLoopModel: 'qwen3.5-9b-neo-nonexistent-dummy', // 保證摘要會失敗
  },
  abortController: new AbortController(),
} as unknown as Parameters<typeof SessionSearchTool.call>[1]
const fakeCanUseTool = (async () => ({ behavior: 'allow' as const })) as Parameters<
  typeof SessionSearchTool.call
>[2]
const fakeParent = {} as Parameters<typeof SessionSearchTool.call>[3]

async function runSearch(input: { query: string; limit?: number; summarize?: boolean }) {
  return SessionSearchTool.call(input, fakeCtx, fakeCanUseTool, fakeParent)
}

try {
  console.log('Test 1: FTS 搜尋「weather」')
  const r1 = await runSearch({ query: 'weather', limit: 10 })
  check('回傳 data 物件', typeof r1.data === 'object')
  check('usedFallback=false', r1.data.usedFallback === false)
  check('totalMatches > 0', (r1.data.totalMatches ?? 0) > 0, `total=${r1.data.totalMatches}`)
  check(
    'returnedMatches 受 limit 控制',
    r1.data.returnedMatches <= 10,
    `returned=${r1.data.returnedMatches}`,
  )
  check('有 sessions 分組', r1.data.sessions.length > 0)
  if (r1.data.sessions.length > 0) {
    const s = r1.data.sessions[0]!
    check('session.title 有值', typeof s.title === 'string' && s.title.length > 0)
    check('session.started_at > 0', s.started_at > 0)
    check('session.matches 有內容', s.matches.length > 0)
    if (s.matches.length > 0) {
      const m = s.matches[0]!
      check('match.snippet 不為空', m.snippet.length > 0)
      check('match.role 有值', typeof m.role === 'string')
    }
  }

  console.log()
  console.log('Test 2: FTS 搜尋「llama」（中英混合內容命中）')
  const r2 = await runSearch({ query: 'llama', limit: 5 })
  check('llama 有命中', r2.data.totalMatches > 0, `total=${r2.data.totalMatches}`)

  console.log()
  console.log('Test 3: 短 query 觸發 fallback（< 3 char）')
  const r3 = await runSearch({ query: '你' })
  check('usedFallback=true', r3.data.usedFallback === true)
  // 視 session.first_user_message 有無「你」而定
  console.log(`    fallback 找到 ${r3.data.sessions.length} 筆`)

  console.log()
  console.log('Test 4: 2-char 中文「天氣」也走 fallback')
  const r4 = await runSearch({ query: '天氣' })
  check('「天氣」usedFallback=true', r4.data.usedFallback === true)

  console.log()
  console.log('Test 5: 3-char 中文走 FTS 路徑')
  const r5 = await runSearch({ query: '討論過' })
  check('「討論過」usedFallback=false', r5.data.usedFallback === false)

  console.log()
  console.log('Test 6: summarize=true 且 llamacpp 不可達 → graceful fallback（M2-06）')
  const r6 = await runSearch({ query: 'weather', limit: 2, summarize: true })
  check('summaryPending=true（摘要失敗）', r6.data.summaryPending === true)
  check(
    'note 提示摘要失敗',
    (r6.data.note?.includes('失敗') ?? false) ||
      (r6.data.note?.includes('解析失敗') ?? false),
    r6.data.note ?? '(none)',
  )
  check(
    'sessions[*].summary 全部為 undefined',
    r6.data.sessions.every(s => s.summary === undefined),
  )
  check(
    'raw matches 仍存在（fallback）',
    r6.data.sessions.length > 0 && r6.data.sessions[0]!.matches.length > 0,
  )
  // 驗證 output map：失敗 fallback 時走 M2-05 的 raw matches 格式，不走 summary 行
  const block6 = SessionSearchTool.mapToolResultToToolResultBlockParam(
    r6.data,
    'test-6-id',
  )
  const txt6 = typeof block6.content === 'string' ? block6.content : ''
  check('失敗 fallback 輸出仍含 match 列「- [role」', txt6.includes('- ['))

  console.log()
  console.log('Test 7: FTS5 reserved 字元（含 "."）不炸')
  let threw = false
  try {
    const r7 = await runSearch({ query: 'llama.cpp' })
    check(
      '含 "." 的 query 不拋錯',
      r7.data.totalMatches !== undefined,
      `total=${r7.data.totalMatches}`,
    )
  } catch {
    threw = true
  }
  check('含 "." 的 query call 不拋例外', !threw)

  console.log()
  console.log('Test 8: 空結果時輸出友善訊息（mapToolResult）')
  const r8 = await runSearch({ query: 'zzzimpossiblequeryzzz' })
  check('空結果 sessions.length=0', r8.data.sessions.length === 0)
  check('totalMatches=0', r8.data.totalMatches === 0)

  const block = SessionSearchTool.mapToolResultToToolResultBlockParam(r8.data, 'test-id')
  check('空結果 tool_result 是 string', typeof block.content === 'string')
  check(
    '空結果訊息含「未找到」',
    (typeof block.content === 'string' && block.content.includes('未找到')) === true,
  )

  console.log()
  console.log('Test 9: 有結果時輸出 markdown 格式')
  const block2 = SessionSearchTool.mapToolResultToToolResultBlockParam(
    r1.data,
    'test-id-2',
  )
  const txt = typeof block2.content === 'string' ? block2.content : ''
  check('含 「找到」開頭', txt.startsWith('找到'))
  check('含 「## [」session header', txt.includes('## ['))

  console.log()
  console.log('Test 10: summary 存在時輸出格式改走 summary 單行（mock）')
  // 直接 mock summary field 驗證 mapToolResultToToolResultBlockParam 優先顯示 summary
  const mockedOutput = {
    ...r1.data,
    sessions: r1.data.sessions.map((s, i) => ({
      ...s,
      summary: i === 0 ? '這個 session 在討論天氣查詢 API 的選擇。' : undefined,
    })),
  }
  const block3 = SessionSearchTool.mapToolResultToToolResultBlockParam(
    mockedOutput,
    'test-id-3',
  )
  const txt3 = typeof block3.content === 'string' ? block3.content : ''
  check('含 summary 文字', txt3.includes('天氣查詢 API 的選擇'))
  // 有 summary 的 session 下方不該有 raw match 列「- [role] ...」（改由 summary 取代）
  // 驗證方式：抓到第一個 ## 後到下一個 ## 間的區塊不含 "- ["
  const firstBlock = txt3.split('\n\n## ')[0] ?? ''
  check(
    '有 summary 的 session 塊不再列 raw match',
    !firstBlock.split('\n').some(line => line.startsWith('- [')),
  )

  console.log()
  console.log('--- 實際輸出樣本（limit=3）---')
  const sample = await runSearch({ query: 'weather', limit: 3 })
  const sampleBlock = SessionSearchTool.mapToolResultToToolResultBlockParam(
    sample.data,
    'sample-id',
  )
  console.log(sampleBlock.content)
} catch (err) {
  console.error()
  console.error('[smoke] FATAL:', err)
  failed++
} finally {
  console.log()
  console.log(`[smoke] ${passed} passed, ${failed} failed`)
  try {
    const { closeAllSessionIndexes } = await import(
      '../../src/services/sessionIndex/index.js'
    )
    closeAllSessionIndexes()
  } catch {
    // noop
  }
  process.exit(failed > 0 ? 1 : 0)
}
