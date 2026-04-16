/**
 * 查當前 project 的 session-index.db（M2-04 手動驗證用）。
 * Usage: bun run scripts/poc/query-session-index.ts
 */
import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'

const dbPath = join(
  homedir(),
  '.my-agent',
  'projects',
  'C--Users-LOREN-Documents--projects-free-code',
  'session-index.db',
)

console.log(`DB: ${dbPath}\n`)

// 用 readonly 避免和可能還在跑的 TUI 搶鎖
const db = new Database(dbPath, { readonly: true })

console.log('=== schema_version ===')
console.log(db.query('SELECT * FROM schema_version').all())

console.log('\n=== sessions（全部，依 started_at 排） ===')
const sessions = db
  .query<
    {
      session_id: string
      message_count: number
      model: string | null
      started_at: number
      ended_at: number | null
      first_user_message: string | null
      last_indexed_at: number | null
    },
    []
  >(
    'SELECT session_id, message_count, model, started_at, ended_at, first_user_message, last_indexed_at FROM sessions ORDER BY started_at',
  )
  .all()

for (const s of sessions) {
  console.log({
    id: s.session_id.slice(0, 8) + '...',
    msg: s.message_count,
    model: s.model,
    started: new Date(s.started_at).toISOString(),
    ended: s.ended_at ? new Date(s.ended_at).toISOString() : null,
    indexed: s.last_indexed_at ? new Date(s.last_indexed_at).toISOString() : null,
    first_user: (s.first_user_message || '').slice(0, 80),
  })
}

const ftsCount = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages_fts').get()
const seenCount = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages_seen').get()
console.log(`\nmessages_fts 總筆數: ${ftsCount?.c}`)
console.log(`messages_seen 總筆數: ${seenCount?.c}`)

console.log('\n=== FTS 搜尋「天氣」===')
const hits1 = db
  .query<{ session_id: string; role: string; tool_name: string | null; preview: string }, [string]>(
    'SELECT session_id, role, tool_name, substr(content, 1, 120) as preview FROM messages_fts WHERE messages_fts MATCH ? LIMIT 10',
  )
  .all('天氣')
console.log(`找到 ${hits1.length} 筆：`)
for (const h of hits1) {
  console.log(`  [${h.session_id.slice(0, 8)}] ${h.role}${h.tool_name ? ' (tool=' + h.tool_name + ')' : ''}`)
  console.log(`    ${h.preview.replace(/\n/g, ' | ')}`)
}

console.log('\n=== FTS 搜尋「weather」===')
const hits2 = db
  .query<{ session_id: string; role: string; tool_name: string | null; preview: string }, [string]>(
    'SELECT session_id, role, tool_name, substr(content, 1, 120) as preview FROM messages_fts WHERE messages_fts MATCH ? LIMIT 10',
  )
  .all('weather')
console.log(`找到 ${hits2.length} 筆：`)
for (const h of hits2) {
  console.log(`  [${h.session_id.slice(0, 8)}] ${h.role}${h.tool_name ? ' (tool=' + h.tool_name + ')' : ''}`)
  console.log(`    ${h.preview.replace(/\n/g, ' | ')}`)
}

console.log('\n=== 各 session 的 FTS 筆數分布 ===')
const dist = db
  .query<{ session_id: string; c: number }, []>(
    'SELECT session_id, COUNT(*) as c FROM messages_fts GROUP BY session_id ORDER BY c DESC',
  )
  .all()
for (const d of dist) {
  console.log(`  ${d.session_id.slice(0, 8)}...  ${d.c} 筆`)
}

console.log('\n=== 用過的工具（從 tool_name 欄位）===')
const tools = db
  .query<{ tool_name: string; c: number }, []>(
    "SELECT tool_name, COUNT(*) as c FROM messages_fts WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC",
  )
  .all()
for (const t of tools) {
  console.log(`  ${t.tool_name}: ${t.c} 次`)
}

db.close()
