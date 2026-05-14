/**
 * `bun:sqlite` Node 環境 stub。
 *
 * Phase 3：bundle 時用此檔取代 `import { Database } from 'bun:sqlite'`，
 * 讓桌寵 Electron Node runtime 可以 import bundle 不爆 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 *
 * 執行期 — 任何 code path 真的試圖 `new Database()` 時 throw；session
 * index 為 daemon / Discord / web 模式才用，embedded mascot 預設 session
 * 持久化走 NDJSON（sessionStoragePortable）不會碰到。
 *
 * Phase 4 將正式以 `better-sqlite3` 取代（API 接近，介面層替換可控）。
 */

class StubDatabase {
  constructor(_path?: string, _opts?: unknown) {
    throw new Error(
      'bun:sqlite not available in Node runtime — Phase 4 將以 better-sqlite3 取代 ' +
        '(session index DB 在 embedded mascot 模式下不應被執行)',
    )
  }
}

export { StubDatabase as Database }
export default StubDatabase
