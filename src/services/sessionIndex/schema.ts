/**
 * Session index SQLite schema（ADR-M2-08）。
 *
 * 兩張表：
 * - sessions：一列一個 session，存元資料（起訖時間、模型、tokens、成本、last_indexed_at）
 * - messages_fts：FTS5 virtual table，content 欄位建索引，其餘 UNINDEXED 只作 filter/return
 *
 * 注意：
 * - messages_fts 用一般（非 contentless）FTS5 — JSONL 是 source of truth，不用鏡像到 base table
 * - tokenize 用 'trigram'（SQLite 3.34+），對中英文混合與 substring 比對都 OK
 *   **限制**：trigram 查詢字串須 ≥3 字元，`"KV"` / `"討論"` 這類 2-char 查詢會回 0 筆；
 *   SessionSearchTool（M2-05）需在上層驗證並提示或擴展查詢
 * - unicode61 為 fallback（罕見），另有「整段 CJK 當一個 token」的副作用 → 短 CJK 查詢反而難命中
 * - schema_version 目前 1；未來 migration 透過新增 CASE 分支向上升
 */
export const SCHEMA_VERSION = 1

/** 建立 sessions / schema_version 表與索引（IF NOT EXISTS，可重複執行）。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  model TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_user_message TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  last_indexed_at INTEGER,
  parent_session_id TEXT REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
`

/**
 * 建立 messages_fts 虛擬表。UNINDEXED 欄位不建 FTS，只供 filter / return。
 * tokenize='trigram' 對中英文都 OK；若執行環境 SQLite 不支援（<3.34），
 * openSessionIndex 會 catch 錯誤並 fallback 到 unicode61。
 */
export const FTS_SQL_TRIGRAM = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  message_index UNINDEXED,
  role UNINDEXED,
  timestamp UNINDEXED,
  tool_name UNINDEXED,
  finish_reason UNINDEXED,
  content,
  tokenize = 'trigram'
);
`

/** Fallback：舊 SQLite / 不支援 trigram 時用。中文搜尋品質較差。 */
export const FTS_SQL_UNICODE61 = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  message_index UNINDEXED,
  role UNINDEXED,
  timestamp UNINDEXED,
  tool_name UNINDEXED,
  finish_reason UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
`
