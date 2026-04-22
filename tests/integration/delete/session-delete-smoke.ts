#!/usr/bin/env bun
/**
 * M-DELETE-2 smoke：sessionIndex deleteSession + listSessions。
 *
 * bun run tests/integration/delete/session-delete-smoke.ts
 */
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import {
  FTS_SQL_TRIGRAM,
  SCHEMA_SQL,
} from '../../../src/services/sessionIndex/schema.js'
import {
  deleteSessionWithDb,
  listSessionsWithDb,
} from '../../../src/services/sessionIndex/delete.js'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

const testRoot = join(tmpdir(), `my-agent-delete-test-${Date.now()}`)
mkdirSync(testRoot, { recursive: true })
const dbPath = join(testRoot, 'session-index.db')
const db = new Database(dbPath, { create: true })
db.exec('PRAGMA journal_mode = WAL')
db.exec(SCHEMA_SQL)
db.exec(FTS_SQL_TRIGRAM)

function insertSession(id: string, startedAt: number, firstUser: string) {
  db.query(
    `INSERT INTO sessions (session_id, started_at, ended_at, model, message_count,
     first_user_message, total_input_tokens, total_output_tokens, estimated_cost_usd,
     last_indexed_at, parent_session_id)
     VALUES (?, ?, ?, 'llama', 5, ?, 100, 50, 0.01, ?, NULL)`,
  ).run(id, startedAt, startedAt + 1000, firstUser, startedAt + 1000)
}
function insertFtsRow(sessionId: string, content: string) {
  db.query(
    `INSERT INTO messages_fts (session_id, message_index, role, timestamp, tool_name, finish_reason, content)
     VALUES (?, 0, 'user', 0, NULL, NULL, ?)`,
  ).run(sessionId, content)
}
function insertSeen(sessionId: string, uuid: string) {
  db.query(
    `INSERT INTO messages_seen (session_id, uuid) VALUES (?, ?)`,
  ).run(sessionId, uuid)
}

try {
  const now = Date.now()
  const oneDay = 24 * 3600 * 1000

  // 插三個 session：今天、3 天前、10 天前
  insertSession('sess-today', now - 1000, 'fix the bug today')
  insertSession('sess-3d', now - 3 * oneDay, 'discord gateway debug')
  insertSession('sess-10d', now - 10 * oneDay, 'initial planning session')

  // 每個 session 兩筆 FTS + 兩筆 seen
  insertFtsRow('sess-today', 'some content A')
  insertFtsRow('sess-today', 'some content B')
  insertFtsRow('sess-3d', 'gateway discord stuff')
  insertFtsRow('sess-3d', 'more gateway text')
  insertFtsRow('sess-10d', 'early planning content')
  insertSeen('sess-today', '11111111-1111-1111-1111-111111111111')
  insertSeen('sess-today', '22222222-2222-2222-2222-222222222222')
  insertSeen('sess-3d', '33333333-3333-3333-3333-333333333333')
  insertSeen('sess-10d', '44444444-4444-4444-4444-444444444444')

  section('listSessions 基本')
  const all = listSessionsWithDb(db)
  assert(all.length === 3, '列出 3 個 session')
  assert(all[0].sessionId === 'sess-today', 'DESC 排序 — 最新在前')
  assert(all[2].sessionId === 'sess-10d', '最舊在尾')

  section('listSessions 時間範圍')
  const recent = listSessionsWithDb(db, { sinceMs: now - 5 * oneDay })
  assert(recent.length === 2, '5 天內 2 筆')
  assert(
    recent.every(r => r.sessionId !== 'sess-10d'),
    '10 天前被排除',
  )

  section('listSessions 關鍵字')
  const kw = listSessionsWithDb(db, { keyword: 'discord' })
  assert(kw.length === 1, 'keyword discord 命中 1 筆')
  assert(kw[0].sessionId === 'sess-3d', '命中的是 sess-3d')

  const kwNone = listSessionsWithDb(db, { keyword: 'nonsense-xyz' })
  assert(kwNone.length === 0, '無命中 → 空陣列')

  section('listSessions limit/offset')
  const page1 = listSessionsWithDb(db, { limit: 2 })
  assert(page1.length === 2, 'limit=2 回 2 筆')
  const page2 = listSessionsWithDb(db, { limit: 2, offset: 2 })
  assert(page2.length === 1, 'offset=2 剩 1 筆')
  assert(page2[0].sessionId === 'sess-10d', 'offset 後剩最舊')

  section('deleteSession — 存在')
  const r = deleteSessionWithDb(db, 'sess-3d')
  assert(r.existed === true, 'existed=true')
  assert(r.ftsDeleted === 2, 'ftsDeleted=2')
  assert(r.seenDeleted === 1, 'seenDeleted=1')

  const afterDelete = listSessionsWithDb(db)
  assert(afterDelete.length === 2, 'sessions 剩 2')
  assert(
    !afterDelete.some(s => s.sessionId === 'sess-3d'),
    'sess-3d 不在了',
  )

  // FTS + seen 實際已清
  const ftsLeft = db
    .query('SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?')
    .get('sess-3d') as { c: number }
  assert(ftsLeft.c === 0, 'FTS 清空 for sess-3d')
  const seenLeft = db
    .query('SELECT COUNT(*) as c FROM messages_seen WHERE session_id = ?')
    .get('sess-3d') as { c: number }
  assert(seenLeft.c === 0, 'messages_seen 清空 for sess-3d')

  section('deleteSession — 不存在')
  const r2 = deleteSessionWithDb(db, 'ghost-id')
  assert(r2.existed === false, 'existed=false')
  assert(r2.ftsDeleted === 0 && r2.seenDeleted === 0, '0/0')

  section('deleteSession — invalid input')
  let threw = false
  try {
    // @ts-expect-error - 測試 runtime 保護
    deleteSessionWithDb(db, '')
  } catch {
    threw = true
  }
  assert(threw, 'empty sessionId → throw')

  section('transaction 原子性 — delete 不影響其他 session')
  const otherFts = db
    .query('SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?')
    .get('sess-today') as { c: number }
  assert(otherFts.c === 2, 'sess-today 的 FTS 未被影響')
} finally {
  db.close()
  rmSync(testRoot, { recursive: true, force: true })
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`)
process.exit(failed > 0 ? 1 : 0)
