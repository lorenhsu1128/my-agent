/**
 * Session recall FTS 索引（M2）。
 * - paths.ts：索引檔路徑解析
 * - schema.ts：SQLite schema + FTS5 DDL
 * - db.ts：連線管理 + 初始化
 *
 * M2-01 只做基建；讀寫 hook、搜尋工具、prefetch 分別在 M2-02 / M2-05 / M2-09。
 */
export {
  closeAllSessionIndexes,
  closeSessionIndex,
  openSessionIndex,
} from './db.js'
export { indexEntry } from './indexWriter.js'
export { getSessionIndexPath, SESSION_INDEX_FILENAME } from './paths.js'
export { SCHEMA_VERSION } from './schema.js'
