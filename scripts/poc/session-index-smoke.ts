/**
 * Smoke test for M2-01: session index schema + connection.
 *
 * Runs against a throwaway CLAUDE_CONFIG_DIR so ~/.free-code 不會被污染。
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
  check('SCHEMA_VERSION constant', SCHEMA_VERSION === 1, `v=${SCHEMA_VERSION}`)

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
} catch (err) {
  console.error()
  console.error('[smoke] FATAL:', err)
  failed++
} finally {
  console.log()
  console.log(`[smoke] ${passed} passed, ${failed} failed`)
  rmSync(tempHome, { recursive: true, force: true })
  process.exit(failed > 0 ? 1 : 0)
}
