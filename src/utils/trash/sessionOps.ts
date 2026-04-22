/**
 * Session 級別的 trash 操作（M-DELETE-3）。
 *
 * 包裝 filesystem 搬移（trash/index.ts）+ DB 刪除（sessionIndex/delete.ts）
 * 成一個高階 API 給 /session-delete command 使用。
 *
 * 流程：
 *   trashSession(cwd, id)
 *     → 讀取 transcript 路徑與可能的 tool-results 目錄
 *     → moveToTrash 各自獨立 entry（transcript entry + tool-results entry）
 *     → deleteSession DB（硬刪 FTS + sessions + messages_seen）
 *     → 回傳 summary
 *
 *   restoreSession(cwd, trashIds)
 *     → restoreFromTrash 每筆（搬回原路徑）
 *     → 呼叫端可 call reconcileProjectIndex() 重建 FTS
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { getProjectDir } from '../sessionStoragePortable.js'
import { moveToTrash, restoreFromTrash, type TrashMeta } from './index.js'
import { deleteSession } from '../../services/sessionIndex/delete.js'

export type TrashSessionResult = {
  sessionId: string
  /** transcript (jsonl) trash entry；若檔案不存在會是 null */
  transcriptTrashId: string | null
  /** tool-results 目錄 trash entry；若目錄不存在會是 null */
  toolResultsTrashId: string | null
  /** DB 刪除結果 */
  dbDeleted: {
    existed: boolean
    ftsDeleted: number
    seenDeleted: number
  }
}

export function getSessionTranscriptPath(
  cwd: string,
  sessionId: string,
): string {
  return join(getProjectDir(cwd), `${sessionId}.jsonl`)
}

export function getSessionToolResultsDir(
  cwd: string,
  sessionId: string,
): string {
  return join(getProjectDir(cwd), sessionId)
}

/**
 * 把 session 搬進 trash + 硬刪 DB 紀錄。
 * 若 transcript / tool-results 都不存在仍會嘗試刪 DB（孤兒索引清理）。
 */
export function trashSession(
  cwd: string,
  sessionId: string,
): TrashSessionResult {
  if (!sessionId) throw new Error('trashSession: sessionId required')

  const transcriptPath = getSessionTranscriptPath(cwd, sessionId)
  const toolResultsPath = getSessionToolResultsDir(cwd, sessionId)

  let transcriptTrashId: string | null = null
  let toolResultsTrashId: string | null = null

  if (existsSync(transcriptPath)) {
    const meta = moveToTrash({
      cwd,
      kind: 'session',
      sourcePath: transcriptPath,
      label: `${sessionId}.jsonl`,
    })
    transcriptTrashId = meta.id
  }

  if (existsSync(toolResultsPath)) {
    const meta = moveToTrash({
      cwd,
      kind: 'session',
      sourcePath: toolResultsPath,
      label: `${sessionId}/tool-results`,
    })
    toolResultsTrashId = meta.id
  }

  const dbRes = deleteSession(cwd, sessionId)

  return {
    sessionId,
    transcriptTrashId,
    toolResultsTrashId,
    dbDeleted: {
      existed: dbRes.existed,
      ftsDeleted: dbRes.ftsDeleted,
      seenDeleted: dbRes.seenDeleted,
    },
  }
}

/**
 * 從 trash 復原一批 entries。回傳成功的 meta 列表。
 * 失敗的項目會收集到 errors 但不 throw（一筆失敗不影響其他）。
 *
 * 復原後呼叫端需 call `reconcileProjectIndex(cwd)` 才會重建 FTS 索引。
 */
export function restoreSessionEntries(
  cwd: string,
  trashIds: string[],
  opts: { overwrite?: boolean } = {},
): {
  restored: TrashMeta[]
  errors: Array<{ trashId: string; error: string }>
} {
  const restored: TrashMeta[] = []
  const errors: Array<{ trashId: string; error: string }> = []
  for (const id of trashIds) {
    try {
      const meta = restoreFromTrash(cwd, id, opts)
      restored.push(meta)
    } catch (err) {
      errors.push({
        trashId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { restored, errors }
}
