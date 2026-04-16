/**
 * Smoke test：
 * - M2-01：session index schema + connection（27 check）
 * - M2-01 審查：parent_session_id + idx_sessions_parent（3 check）
 * - M2-02：indexEntry tee 流程、shadow dedup、空內容、busy 吞錯（新增 check）
 *
 * 走 throwaway CLAUDE_CONFIG_DIR，不污染真實 ~/.my-agent。
 *
 * Usage:
 *   bun run scripts/poc/session-index-smoke.ts
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Redirect CLAUDE_CONFIG_DIR BEFORE importing anything that memoizes on it.
const tempHome = mkdtempSync(join(tmpdir(), 'freecode-index-smoke-'))
process.env.CLAUDE_CONFIG_DIR = tempHome

const {
  openSessionIndex,
  closeSessionIndex,
  getSessionIndexPath,
  SCHEMA_VERSION,
  indexEntry,
  reconcileProjectIndex,
  ensureReconciled,
  _resetReconcileCacheForTest,
} = await import('../../src/services/sessionIndex/index.js')

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

const cwd = process.cwd()

try {
  console.log(`[smoke] CLAUDE_CONFIG_DIR = ${tempHome}`)
  console.log(`[smoke] index path = ${getSessionIndexPath(cwd)}`)
  console.log()

  console.log('Test 1: 首次開啟建立 schema')
  const db = openSessionIndex(cwd)
  check('db is open', !!db)
  check('SCHEMA_VERSION constant', SCHEMA_VERSION === 2, `v=${SCHEMA_VERSION}`)

  // 檢查 schema_version 表
  const ver = db
    .query<{ version: number }, []>(
      'SELECT version FROM schema_version LIMIT 1',
    )
    .get()
  check('schema_version row exists', ver !== null)
  check('schema_version value', ver?.version === SCHEMA_VERSION)

  // 檢查 sessions 表結構
  const sessionsCols = db
    .query<{ name: string }, []>('PRAGMA table_info(sessions)')
    .all()
    .map(r => r.name)
  const expectedSessionCols = [
    'session_id',
    'started_at',
    'ended_at',
    'model',
    'message_count',
    'first_user_message',
    'total_input_tokens',
    'total_output_tokens',
    'estimated_cost_usd',
    'last_indexed_at',
    'parent_session_id',
  ]
  for (const col of expectedSessionCols) {
    check(
      `sessions.${col} exists`,
      sessionsCols.includes(col),
      `cols=${sessionsCols.length}`,
    )
  }

  // 檢查 messages_fts 虛擬表（用 sqlite_master 查 type=table + sql 含 fts5）
  const ftsRow = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE name = 'messages_fts'",
    )
    .get()
  check('messages_fts exists', ftsRow !== null)
  check('messages_fts uses fts5', ftsRow?.sql.includes('fts5') ?? false)

  // 檢查 PRAGMA
  const journal = db
    .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
    .get()
  check(
    'WAL journal mode',
    journal?.journal_mode === 'wal',
    `mode=${journal?.journal_mode}`,
  )

  console.log()
  console.log('Test 2: 寫入 + 查詢 sessions 表')
  db.query(
    `INSERT INTO sessions (session_id, started_at, model, first_user_message)
     VALUES (?, ?, ?, ?)`,
  ).run('sess-test-1', 1712345678, 'qwen3.5-9b-neo', 'hello world')

  const got = db
    .query<
      { session_id: string; model: string; first_user_message: string },
      []
    >('SELECT session_id, model, first_user_message FROM sessions')
    .get()
  check('session insert roundtrip', got?.session_id === 'sess-test-1')
  check('session.model', got?.model === 'qwen3.5-9b-neo')
  check('session.first_user_message', got?.first_user_message === 'hello world')

  // Compaction chain：插入一個「子 session」指回父 session
  db.query(
    `INSERT INTO sessions (session_id, started_at, parent_session_id, model)
     VALUES (?, ?, ?, ?)`,
  ).run('sess-test-2', 1712345700, 'sess-test-1', 'qwen3.5-9b-neo')
  const child = db
    .query<{ session_id: string; parent_session_id: string | null }, []>(
      "SELECT session_id, parent_session_id FROM sessions WHERE session_id = 'sess-test-2'",
    )
    .get()
  check(
    'parent_session_id FK 可寫入',
    child?.parent_session_id === 'sess-test-1',
    `parent=${child?.parent_session_id}`,
  )

  // 反向查所有 child：驗證 idx_sessions_parent 起作用（用 EXPLAIN QUERY PLAN）
  const plan = db
    .query<{ detail: string }, [string]>(
      'EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE parent_session_id = ?',
    )
    .all('sess-test-1')
    .map(r => r.detail)
    .join(' | ')
  check(
    'idx_sessions_parent 被使用',
    plan.toLowerCase().includes('idx_sessions_parent'),
    plan,
  )

  console.log()
  console.log('Test 3: 寫入 + FTS 查詢 messages_fts')
  db.query(
    `INSERT INTO messages_fts (session_id, message_index, role, timestamp, tool_name, finish_reason, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess-test-1',
    0,
    'user',
    1712345678,
    null,
    null,
    '我們上次討論了 llama.cpp 的 KV cache 設定',
  )
  db.query(
    `INSERT INTO messages_fts (session_id, message_index, role, timestamp, tool_name, finish_reason, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess-test-1',
    1,
    'assistant',
    1712345679,
    null,
    'stop',
    'KV cache 預設在 32K context 大約吃 5GB VRAM',
  )

  // 英文單字查詢（≥3 chars，trigram 可命中）
  const hitsEn = db
    .query<{ content: string }, [string]>(
      'SELECT content FROM messages_fts WHERE messages_fts MATCH ?',
    )
    .all('cache')
  check('FTS hit (英文 "cache")', hitsEn.length >= 1, `hits=${hitsEn.length}`)

  // 中文 3-char 查詢（trigram 需 ≥3 字元；這是 SessionSearchTool 層會處理的限制）
  const hitsCn = db
    .query<{ content: string }, [string]>(
      'SELECT content FROM messages_fts WHERE messages_fts MATCH ?',
    )
    .all('討論了')
  check(
    'FTS hit (中文 "討論了" — 驗證 trigram ≥3 字元)',
    hitsCn.length >= 1,
    `hits=${hitsCn.length}`,
  )

  // 中英混合（「llama.cpp」被 trigram 切成 lla/lam/ama/... 能被 "llama" 命中）
  const hitsMix = db
    .query<{ content: string }, [string]>(
      'SELECT content FROM messages_fts WHERE messages_fts MATCH ?',
    )
    .all('llama')
  check('FTS hit (英文技術詞 "llama")', hitsMix.length >= 1, `hits=${hitsMix.length}`)

  // 短查詢（<3 chars）預期回 0 筆 — 驗證限制真實存在，避免未來以為查詢是好的
  const hitsShort = db
    .query<{ content: string }, [string]>(
      'SELECT content FROM messages_fts WHERE messages_fts MATCH ?',
    )
    .all('KV')
  check(
    '短查詢 "KV" 回 0 筆（trigram 限制的預期行為）',
    hitsShort.length === 0,
    `hits=${hitsShort.length}`,
  )

  console.log()
  console.log('Test 4: 同 cwd 重新 open 回同一 Database（connection cache）')
  const db2 = openSessionIndex(cwd)
  check('open 回 cached db', db2 === db)

  console.log()
  console.log('Test 5: close 後 cache 清空')
  closeSessionIndex(cwd)
  const db3 = openSessionIndex(cwd)
  check('close 後再 open 拿到新 Database', db3 !== db)
  const verAfterReopen = db3
    .query<{ version: number }, []>('SELECT version FROM schema_version')
    .get()
  check(
    '新 Database 仍可查 schema_version',
    verAfterReopen?.version === SCHEMA_VERSION,
  )

  closeSessionIndex(cwd)

  // ========================================================================
  // M2-02：indexEntry tee 流程
  // ========================================================================
  console.log()
  console.log('Test 6: messages_seen shadow 表存在（v2 schema）')
  const dbM2 = openSessionIndex(cwd)
  const seenTable = dbM2
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_seen'",
    )
    .get()
  check('messages_seen 表存在', seenTable !== null)

  console.log()
  console.log('Test 7: indexEntry 寫入 user/assistant 訊息')
  const SESS = 'm2-02-sess-1'

  // 用 user 訊息（string content）
  indexEntry(
    {
      type: 'user',
      uuid: 'uuid-u-1',
      message: { role: 'user', content: '請教我用 llama.cpp 跑本地模型' },
    },
    SESS,
    cwd,
  )
  const rowSess = dbM2
    .query<
      { session_id: string; message_count: number; first_user_message: string },
      [string]
    >(
      'SELECT session_id, message_count, first_user_message FROM sessions WHERE session_id = ?',
    )
    .get(SESS)
  check('sessions 行已建立', rowSess?.session_id === SESS)
  check('message_count = 1', rowSess?.message_count === 1)
  check(
    'first_user_message 摘要（前 200 字）已填',
    (rowSess?.first_user_message ?? '').includes('llama.cpp'),
  )

  // assistant 訊息（ContentBlock[] — text + tool_use + thinking）
  indexEntry(
    {
      type: 'assistant',
      uuid: 'uuid-a-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '使用者想跑本地模型，建議用 serve.sh' },
          { type: 'text', text: '你可以跑 scripts/llama/serve.sh 啟動 server' },
          { type: 'tool_use', name: 'Bash', input: { command: 'bash scripts/llama/serve.sh' } },
        ],
      },
    },
    SESS,
    cwd,
  )
  const rowSess2 = dbM2
    .query<{ message_count: number }, [string]>(
      'SELECT message_count FROM sessions WHERE session_id = ?',
    )
    .get(SESS)
  check('message_count = 2（user + assistant）', rowSess2?.message_count === 2)

  // 驗證 thinking / tool_use input / text 都進 FTS
  const ftsHits = dbM2
    .query<{ content: string; tool_name: string | null }, [string]>(
      'SELECT content, tool_name FROM messages_fts WHERE session_id = ?',
    )
    .all(SESS)
  check('messages_fts 有 2 筆', ftsHits.length === 2)

  const assistantRow = ftsHits.find(r => r.content.includes('serve.sh'))
  check('assistant FTS 含 text', !!assistantRow)
  check(
    'assistant FTS 含 thinking',
    assistantRow?.content.includes('建議用 serve.sh') ?? false,
  )
  check(
    'assistant FTS 含 tool_use input（JSON）',
    assistantRow?.content.includes('[tool:Bash]') ?? false,
  )
  check('assistant tool_name 記錄為 Bash', assistantRow?.tool_name === 'Bash')

  // FTS 搜尋整條鏈：search "serve"（FTS5 MATCH 的 . 是 reserved，需 quote；用純 word 測）
  const sessionSearch = dbM2
    .query<{ session_id: string }, [string]>(
      'SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?',
    )
    .all('serve')
  check('FTS 可搜回 assistant 訊息', sessionSearch.some(r => r.session_id === SESS))

  console.log()
  console.log('Test 8: shadow 表去重 — 同 UUID 第二次呼叫不重複寫')
  indexEntry(
    {
      type: 'user',
      uuid: 'uuid-u-1', // 同 UUID
      message: { role: 'user', content: '應該被忽略的重複內容' },
    },
    SESS,
    cwd,
  )
  const rowSess3 = dbM2
    .query<{ message_count: number }, [string]>(
      'SELECT message_count FROM sessions WHERE session_id = ?',
    )
    .get(SESS)
  check(
    'message_count 仍為 2（去重生效）',
    rowSess3?.message_count === 2,
    `count=${rowSess3?.message_count}`,
  )
  const ftsCountAfterDup = dbM2
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(SESS)
  check(
    'messages_fts 仍為 2 筆（去重生效）',
    ftsCountAfterDup?.c === 2,
    `count=${ftsCountAfterDup?.c}`,
  )

  console.log()
  console.log('Test 9: 空內容訊息不寫入 FTS')
  indexEntry(
    {
      type: 'user',
      uuid: 'uuid-empty-1',
      message: { role: 'user', content: '' },
    },
    SESS,
    cwd,
  )
  const ftsCountAfterEmpty = dbM2
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(SESS)
  check(
    'messages_fts 仍為 2 筆（空內容跳過）',
    ftsCountAfterEmpty?.c === 2,
    `count=${ftsCountAfterEmpty?.c}`,
  )
  // 但 messages_seen 應已為空內容 UUID 建 row（之後若補 content 也不會重複進 FTS — 保守策略）
  const seenEmpty = dbM2
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_seen WHERE uuid = ?',
    )
    .get('uuid-empty-1')
  check('messages_seen 已記錄空內容 uuid', (seenEmpty?.c ?? 0) === 1)

  console.log()
  console.log('Test 10: 非訊息型別（例：tag）早退、不插入')
  indexEntry(
    { type: 'tag', uuid: 'uuid-tag-1' } as unknown as Parameters<typeof indexEntry>[0],
    SESS,
    cwd,
  )
  const ftsCountAfterTag = dbM2
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(SESS)
  check('非訊息型別不插 FTS', ftsCountAfterTag?.c === 2)
  const seenTag = dbM2
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_seen WHERE uuid = ?',
    )
    .get('uuid-tag-1')
  check('非訊息型別也不插 messages_seen', (seenTag?.c ?? 0) === 0)

  console.log()
  console.log('Test 10.5: entry.timestamp 優先於 Date.now()')
  const SESS_TS = 'ts-sess-1'
  const historicIso = '2024-01-15T08:30:45.000Z'
  const historicMs = Date.parse(historicIso)
  indexEntry(
    {
      type: 'user',
      uuid: 'ts-u-1',
      timestamp: historicIso,
      message: { role: 'user', content: '這是歷史訊息，應記錄原 timestamp' },
    },
    SESS_TS,
    cwd,
  )
  const tsDb = openSessionIndex(cwd)
  const tsSess = tsDb
    .query<{ started_at: number; ended_at: number }, [string]>(
      'SELECT started_at, ended_at FROM sessions WHERE session_id = ?',
    )
    .get(SESS_TS)
  check(
    'sessions.started_at = entry.timestamp',
    tsSess?.started_at === historicMs,
    `started=${tsSess?.started_at} expect=${historicMs}`,
  )
  const tsFts = tsDb
    .query<{ timestamp: number }, [string]>(
      'SELECT timestamp FROM messages_fts WHERE session_id = ?',
    )
    .get(SESS_TS)
  check(
    'messages_fts.timestamp = entry.timestamp',
    tsFts?.timestamp === historicMs,
    `ts=${tsFts?.timestamp}`,
  )
  // 第二筆用**更早**的 timestamp，驗證 ended_at 用 MAX（不會被更舊值覆蓋）
  const laterIso = '2024-02-01T12:00:00.000Z'
  indexEntry(
    {
      type: 'assistant',
      uuid: 'ts-a-1',
      timestamp: laterIso,
      message: { role: 'assistant', content: '回覆' },
    },
    SESS_TS,
    cwd,
  )
  // 再來一筆**更舊**的，驗證 ended_at 不被往前拉
  indexEntry(
    {
      type: 'user',
      uuid: 'ts-u-2',
      timestamp: historicIso, // 比上一筆舊
      message: { role: 'user', content: '順序顛倒的訊息' },
    },
    SESS_TS,
    cwd,
  )
  const tsSessFinal = tsDb
    .query<{ ended_at: number }, [string]>(
      'SELECT ended_at FROM sessions WHERE session_id = ?',
    )
    .get(SESS_TS)
  check(
    'ended_at 用 MAX 不被舊 timestamp 覆蓋',
    tsSessFinal?.ended_at === Date.parse(laterIso),
    `ended=${tsSessFinal?.ended_at} expect=${Date.parse(laterIso)}`,
  )

  // 沒 timestamp 的 entry — 應 fallback 到 Date.now()（不能精確斷言，只驗證「有值且近」）
  const SESS_NOW = 'ts-sess-2'
  const beforeNow = Date.now()
  indexEntry(
    {
      type: 'user',
      uuid: 'tsn-u-1',
      message: { role: 'user', content: '沒 timestamp 的訊息' },
    },
    SESS_NOW,
    cwd,
  )
  const afterNow = Date.now()
  const nowSess = tsDb
    .query<{ started_at: number }, [string]>(
      'SELECT started_at FROM sessions WHERE session_id = ?',
    )
    .get(SESS_NOW)
  check(
    '無 timestamp 時 fallback 到 Date.now()',
    (nowSess?.started_at ?? 0) >= beforeNow && (nowSess?.started_at ?? 0) <= afterNow,
    `started=${nowSess?.started_at} in [${beforeNow}, ${afterNow}]`,
  )

  console.log()
  console.log('Test 11: 內部錯誤被吞（絕不拋錯）')
  // 故意傳壞物件；indexEntry 應 try/catch 吞掉
  let threw = false
  try {
    indexEntry(
      null as unknown as Parameters<typeof indexEntry>[0],
      SESS,
      cwd,
    )
  } catch {
    threw = true
  }
  check('壞 entry 不拋錯', !threw)

  closeSessionIndex(cwd)

  // ========================================================================
  // M2-03：reconcileProjectIndex 啟動掃描
  // ========================================================================
  console.log()
  console.log('Test 12: reconcile — 空專案目錄時靜默成功')
  _resetReconcileCacheForTest()
  const { mkdirSync, writeFileSync } = await import('fs')
  const { getProjectDir } = await import(
    '../../src/utils/sessionStoragePortable.js'
  )
  const statsEmpty = await reconcileProjectIndex(cwd)
  check(
    '空目錄 sessionsScanned=0',
    statsEmpty.sessionsScanned === 0,
    `scanned=${statsEmpty.sessionsScanned}`,
  )
  check('空目錄 errors=0', statsEmpty.errors === 0)

  console.log()
  console.log('Test 13: reconcile — 建假 JSONL 然後掃描')
  const projectDir = getProjectDir(cwd)
  mkdirSync(projectDir, { recursive: true })

  // session A：3 個訊息
  const sessA = 'recon-sess-A'
  const jsonlA = join(projectDir, `${sessA}.jsonl`)
  const linesA = [
    {
      type: 'user',
      uuid: 'reconA-u1',
      sessionId: sessA,
      message: { role: 'user', content: '我要寫一個 memoir 的小程式' },
    },
    {
      type: 'assistant',
      uuid: 'reconA-a1',
      sessionId: sessA,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的，讓我幫你設計。' },
          { type: 'tool_use', name: 'Write', input: { file_path: 'memoir.py' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'reconA-u2',
      sessionId: sessA,
      message: { role: 'user', content: '加上註解' },
    },
  ]
  writeFileSync(jsonlA, linesA.map(e => JSON.stringify(e)).join('\n') + '\n')

  // session B：1 個訊息 + 1 個壞行（JSON 解析失敗）+ 1 個 sidechain 需跳過
  const sessB = 'recon-sess-B'
  const jsonlB = join(projectDir, `${sessB}.jsonl`)
  const linesB = [
    JSON.stringify({
      type: 'user',
      uuid: 'reconB-u1',
      sessionId: sessB,
      message: { role: 'user', content: '這是第二個 session 的訊息' },
    }),
    '{ this is not valid json',
    JSON.stringify({
      type: 'user',
      uuid: 'reconB-sidechain',
      sessionId: sessB,
      isSidechain: true,
      agentId: 'agent-x',
      message: { role: 'user', content: '這筆應該被跳過 (sidechain)' },
    }),
  ]
  writeFileSync(jsonlB, linesB.join('\n') + '\n')

  _resetReconcileCacheForTest()
  const stats1 = await reconcileProjectIndex(cwd)
  check(
    'sessionsScanned = 2',
    stats1.sessionsScanned === 2,
    `scanned=${stats1.sessionsScanned}`,
  )
  check(
    'sessionsIndexed = 2',
    stats1.sessionsIndexed === 2,
    `indexed=${stats1.sessionsIndexed}`,
  )
  check('newSessions = 2', stats1.newSessions === 2, `new=${stats1.newSessions}`)
  check(
    'messagesIndexed = 4（A: 3 + B: 1；sidechain 跳過）',
    stats1.messagesIndexed === 4,
    `msg=${stats1.messagesIndexed}`,
  )
  check('errors = 1（壞 JSON 那行）', stats1.errors === 1, `err=${stats1.errors}`)

  // 驗證實際寫進 DB
  const dbR = openSessionIndex(cwd)
  const ftsCountA = dbR
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(sessA)
  check('session A FTS 有 3 筆', ftsCountA?.c === 3, `count=${ftsCountA?.c}`)
  const ftsCountB = dbR
    .query<{ c: number }, [string]>(
      'SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?',
    )
    .get(sessB)
  check('session B FTS 有 1 筆（sidechain 跳過）', ftsCountB?.c === 1, `count=${ftsCountB?.c}`)

  const lastA = dbR
    .query<{ last_indexed_at: number | null }, [string]>(
      'SELECT last_indexed_at FROM sessions WHERE session_id = ?',
    )
    .get(sessA)
  check('session A last_indexed_at 已設', (lastA?.last_indexed_at ?? 0) > 0)

  console.log()
  console.log('Test 14: reconcile — 再跑一次（up-to-date）跳過所有 session')
  _resetReconcileCacheForTest()
  const stats2 = await reconcileProjectIndex(cwd)
  check(
    'sessionsScanned = 2',
    stats2.sessionsScanned === 2,
    `scanned=${stats2.sessionsScanned}`,
  )
  check(
    'sessionsIndexed = 0（全 up-to-date）',
    stats2.sessionsIndexed === 0,
    `indexed=${stats2.sessionsIndexed}`,
  )
  check(
    'messagesIndexed = 0',
    stats2.messagesIndexed === 0,
    `msg=${stats2.messagesIndexed}`,
  )

  console.log()
  console.log('Test 15: ensureReconciled 冪等（同 projectRoot 回同一 Promise）')
  _resetReconcileCacheForTest()
  const p1 = ensureReconciled(cwd)
  const p2 = ensureReconciled(cwd)
  check('ensureReconciled 快取 Promise', p1 === p2)
  await p1 // 確保跑完不影響後續

  closeSessionIndex(cwd)
} catch (err) {
  console.error()
  console.error('[smoke] FATAL:', err)
  failed++
} finally {
  // 關閉所有 db 連線讓 Windows 能釋放檔案鎖，否則 rmSync 會 EBUSY
  try {
    const { closeAllSessionIndexes } = await import(
      '../../src/services/sessionIndex/index.js'
    )
    closeAllSessionIndexes()
  } catch {
    // 無所謂
  }
  console.log()
  console.log(`[smoke] ${passed} passed, ${failed} failed`)
  try {
    rmSync(tempHome, { recursive: true, force: true })
  } catch {
    // Windows 偶爾還在釋放；不影響測試結果
  }
  process.exit(failed > 0 ? 1 : 0)
}
