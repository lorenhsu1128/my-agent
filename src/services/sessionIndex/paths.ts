/**
 * Session FTS 索引檔路徑解析。
 *
 * 索引檔放在 transcripts 旁邊：{CLAUDE_CONFIG_HOME}/projects/{sanitized-cwd}/session-index.db
 * - CLAUDE_CONFIG_HOME 預設 ~/.free-code，可被 CLAUDE_CONFIG_DIR env 覆寫
 * - sanitized-cwd 由 sessionStoragePortable.getProjectDir() 計算，與 JSONL transcripts 共用
 *   同一套 slug → 永遠指向同一 project 目錄，不會漂移
 *
 * ADR-M2-07：索引與 transcripts 放一起，不另起樹。
 */
import { join } from 'path'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'

export const SESSION_INDEX_FILENAME = 'session-index.db'

/** 回傳指定 cwd 的 session-index.db 絕對路徑（檔案可能尚未存在）。 */
export function getSessionIndexPath(cwd: string): string {
  return join(getProjectDir(cwd), SESSION_INDEX_FILENAME)
}
