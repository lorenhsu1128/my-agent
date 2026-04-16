/**
 * Smoke test for SessionSearchTool（M2-05）。
 *
 * 跑在使用者真實 session-index.db 上（~/.free-code/projects/{slug}/），
 * 只讀、不改。需先跑過 rebuild-session-index 或 TUI 讓 index 有資料。
 *
 * Usage: bun run scripts/poc/session-search-tool-smoke.ts
 */
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

// Minimal context stub — SessionSearchTool.call 不依賴任何 context 欄位
const fakeCtx = {} as Parameters<typeof SessionSearchTool.call>[1]
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
  console.log('Test 6: summarize=true 帶 pending flag')
  const r6 = await runSearch({ query: 'weather', limit: 2, summarize: true })
  check('summaryPending=true', r6.data.summaryPending === true)
  check('note 有提示 M2-06', r6.data.note?.includes('M2-06') ?? false)

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
