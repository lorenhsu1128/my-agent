/**
 * M-DELETE-4：memory 條目的軟刪除 helper（供 /memory-delete picker 用）。
 *
 * 與 MemoryTool 的 `remove` 動作差異：
 * - MemoryTool.remove：`unlink` 永久刪除（agent 觸發，LLM 自負責任）
 * - 本 helper：`moveToTrash` 軟刪（人類 picker 觸發，保留可還原性）
 *
 * 同時維護 MEMORY.md 索引行（regex 定位 `filename`）。寫入用 temp+rename 原子。
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from 'fs'
import { join, normalize, basename } from 'path'
import { moveToTrash, type TrashMeta } from './trash/index.js'

export const MEMORY_INDEX_FILENAME = 'MEMORY.md'

export type MemoryDeleteResult = {
  filename: string
  filePath: string
  trashId: string
  indexLineRemoved: boolean
}

/** 驗證 filename 安全性（不允許路徑分隔符、`..`、null byte、或指向 MEMORY.md）。 */
export function assertSafeMemoryFilename(
  filename: string,
  memDir: string,
): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('filename required')
  }
  if (!filename.endsWith('.md')) {
    throw new Error('filename must end with .md')
  }
  if (/[/\\]/.test(filename)) {
    throw new Error('filename must not contain path separators')
  }
  if (filename.includes('..')) {
    throw new Error('filename must not contain ".."')
  }
  if (filename.includes('\0')) {
    throw new Error('filename must not contain null byte')
  }
  if (filename === MEMORY_INDEX_FILENAME) {
    throw new Error(`must not target the index file ${MEMORY_INDEX_FILENAME}`)
  }
  const target = normalize(join(memDir, filename))
  const normalizedDir = normalize(memDir)
  if (!target.startsWith(normalizedDir)) {
    throw new Error('path traversal detected')
  }
  return target
}

function atomicWriteSync(targetPath: string, content: string): void {
  const tmp = targetPath + '.tmp'
  writeFileSync(tmp, content, 'utf-8')
  try {
    renameSync(tmp, targetPath)
  } catch {
    writeFileSync(targetPath, content, 'utf-8')
    try {
      unlinkSync(tmp)
    } catch {
      // ignore
    }
  }
}

/**
 * 從 MEMORY.md 移除對應 filename 的索引行。回傳是否有異動。
 */
export function removeMemoryIndexLine(
  memDir: string,
  filename: string,
): boolean {
  const indexPath = join(memDir, MEMORY_INDEX_FILENAME)
  if (!existsSync(indexPath)) return false
  const original = readFileSync(indexPath, 'utf-8')
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*-\\s*\\[.*\\]\\(\\s*${escaped}\\s*\\)`)
  const lines = original.split('\n')
  const idx = lines.findIndex(l => pattern.test(l))
  if (idx === -1) return false
  lines.splice(idx, 1)
  atomicWriteSync(indexPath, lines.join('\n'))
  return true
}

/**
 * 軟刪除 memory 條目：把 .md 檔搬到 trash、更新 MEMORY.md 索引。
 *
 * @param cwd     專案 cwd（決定 `.trash/` 位置）
 * @param memDir  memory 目錄絕對路徑（auto-memory dir）
 * @param filename  要刪除的檔名（不含路徑），如 `user_role.md`
 */
export function softDeleteMemoryEntry(params: {
  cwd: string
  memDir: string
  filename: string
}): MemoryDeleteResult {
  const { cwd, memDir, filename } = params
  const filePath = assertSafeMemoryFilename(filename, memDir)
  if (!existsSync(filePath)) {
    throw new Error(`memory file not found: ${filename}`)
  }
  const meta: TrashMeta = moveToTrash({
    cwd,
    kind: 'memory',
    sourcePath: filePath,
    label: filename,
  })
  const indexLineRemoved = removeMemoryIndexLine(memDir, filename)
  return {
    filename,
    filePath,
    trashId: meta.id,
    indexLineRemoved,
  }
}

/**
 * 軟刪除整個獨立檔案（非 memdir 條目）— 用於 MY-AGENT.md / ./.my-agent/*.md / daily logs。
 * 不動任何索引。
 */
export function softDeleteStandaloneFile(params: {
  cwd: string
  sourcePath: string
  kind: 'project-memory' | 'daily-log'
  label?: string
}): { trashId: string; sourcePath: string } {
  const { cwd, sourcePath, kind, label } = params
  if (!existsSync(sourcePath)) {
    throw new Error(`file not found: ${sourcePath}`)
  }
  const meta = moveToTrash({
    cwd,
    kind,
    sourcePath,
    label: label ?? basename(sourcePath),
  })
  return { trashId: meta.id, sourcePath }
}
