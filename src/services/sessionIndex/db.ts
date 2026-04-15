/**
 * Session index 連線管理。
 *
 * - 同 cwd 共用一個 Database 物件（連線 cache by absolute path）
 * - WAL mode + busy_timeout（Hermes 做法，避免 writer convoy）
 * - 首次開啟或 schema 升級時自動跑 SCHEMA_SQL + FTS_SQL
 * - FTS5 trigram 不支援時自動 fallback 到 unicode61（罕見，Bun 近年 SQLite 夠新）
 *
 * Callers 只需 openSessionIndex(cwd) 拿 Database；closeSessionIndex 供關機 / 測試清理。
 *
 * 本檔**不做**讀寫業務邏輯（留到 M2-02+）。此檔只負責「拿到一個準備好的 db handle」。
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { getSessionIndexPath } from './paths.js'
import {
  FTS_SQL_TRIGRAM,
  FTS_SQL_UNICODE61,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './schema.js'

const connections = new Map<string, Database>()

/**
 * 開啟（或取得快取的）session-index.db。
 * 首次呼叫會自動建目錄、執行 schema、套用 PRAGMA、寫入 schema_version。
 * 同一 cwd 之後的呼叫回同一 Database 物件。
 */
export function openSessionIndex(cwd: string): Database {
  const path = getSessionIndexPath(cwd)
  const cached = connections.get(path)
  if (cached) return cached

  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })

  // PRAGMA 順序參考 Hermes hermes_state.py：WAL 允許多 reader + 單 writer；
  // busy_timeout 短（1s）+ 應用層 retry with jitter（M2-02 再加）避免 convoy。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 1000')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  initializeSchema(db, path)
  connections.set(path, db)
  return db
}

/** 關閉指定 cwd 的 db 連線並從 cache 移除。主要供測試 / shutdown 使用。 */
export function closeSessionIndex(cwd: string): void {
  const path = getSessionIndexPath(cwd)
  const db = connections.get(path)
  if (db) {
    db.close()
    connections.delete(path)
  }
}

/** 關掉所有已開啟的連線（程序結束前清理）。 */
export function closeAllSessionIndexes(): void {
  for (const db of connections.values()) {
    try {
      db.close()
    } catch {
      // 連線可能已 close，忽略
    }
  }
  connections.clear()
}

function initializeSchema(db: Database, path: string): void {
  db.exec(SCHEMA_SQL)

  // FTS5 trigram 需 SQLite 3.34+。Bun 1.3.x 捆的 SQLite 遠新於此，
  // 但保留 fallback 以防未來執行環境變動。
  try {
    db.exec(FTS_SQL_TRIGRAM)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // biome-ignore lint/suspicious/noConsole: one-time startup warning
    console.warn(
      `[sessionIndex] trigram tokenizer unavailable (${msg}), falling back to unicode61. ` +
        `中文搜尋品質將降低。`,
    )
    db.exec(FTS_SQL_UNICODE61)
  }

  const row = db
    .query<{ version: number }, []>(
      'SELECT version FROM schema_version LIMIT 1',
    )
    .get()

  if (row === null) {
    db.query('INSERT INTO schema_version (version) VALUES (?)').run(
      SCHEMA_VERSION,
    )
    return
  }

  if (row.version !== SCHEMA_VERSION) {
    throw new Error(
      `[sessionIndex] schema version mismatch at ${path}: ` +
        `db=${row.version}, code=${SCHEMA_VERSION}. ` +
        `No migration path implemented yet — 刪除索引檔讓它重建：` +
        `rm "${path}"`,
    )
  }
}
