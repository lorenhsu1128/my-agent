/**
 * 軟刪除 trash 層。
 *
 * `<projectDir>/.trash/<id>/`
 *   ├── meta.json         — { id, kind, originalPath, sessionId?, createdAt, sizeBytes }
 *   └── payload/          — 搬進來的檔案或目錄（保留原始命名在這個 dir 底下）
 *
 * - ID 格式：`<kind>-<epochMs>-<randomHex4>`（排序友好、可手動辨識）
 * - moveToTrash 用 fs.rename（同檔案系統 O(1)）；跨 fs 失敗 fallback 到 copy+unlink
 * - DB 紀錄的刪除**不在這層**處理（由呼叫端自行刪 FTS 等）；這層只管檔案系統
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from 'fs'
import { basename, dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { getProjectDir } from '../sessionStoragePortable.js'

export const TRASH_DIRNAME = '.trash'

export type TrashKind = 'session' | 'memory' | 'project-memory' | 'daily-log'

export type TrashMeta = {
  /** 唯一 id（即 .trash 下的目錄名） */
  id: string
  kind: TrashKind
  /** 原始檔案 / 目錄絕對路徑（restore 用） */
  originalPath: string
  /** 額外 metadata — 例如 sessionId / memory name */
  label?: string
  /** 軟刪時間（epoch ms） */
  createdAt: number
  /** payload 總大小（bytes）— 近似值供 UI 顯示 */
  sizeBytes?: number
}

/** 取得 `<projectDir>/.trash` 絕對路徑（不保證已建立）。 */
export function getTrashDir(cwd: string): string {
  return join(getProjectDir(cwd), TRASH_DIRNAME)
}

function ensureTrashDir(cwd: string): string {
  const dir = getTrashDir(cwd)
  mkdirSync(dir, { recursive: true })
  return dir
}

function generateTrashId(kind: TrashKind): string {
  const ts = Date.now()
  const rand = randomBytes(2).toString('hex')
  return `${kind}-${ts}-${rand}`
}

function directorySize(path: string): number {
  try {
    const st = statSync(path)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    let total = 0
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      total += directorySize(join(path, entry.name))
    }
    return total
  } catch {
    return 0
  }
}

/**
 * 把檔案或目錄搬進 trash。回傳 TrashMeta。
 * sourcePath 不存在或搬移失敗會 throw。
 */
export function moveToTrash(params: {
  cwd: string
  kind: TrashKind
  sourcePath: string
  label?: string
}): TrashMeta {
  const { cwd, kind, sourcePath, label } = params
  if (!existsSync(sourcePath)) {
    throw new Error(`moveToTrash: source not found: ${sourcePath}`)
  }
  const trashRoot = ensureTrashDir(cwd)
  const id = generateTrashId(kind)
  const entryDir = join(trashRoot, id)
  const payloadDir = join(entryDir, 'payload')
  mkdirSync(payloadDir, { recursive: true })

  const payloadName = basename(sourcePath)
  const destPath = join(payloadDir, payloadName)

  try {
    renameSync(sourcePath, destPath)
  } catch (err) {
    // 跨檔案系統 EXDEV 或 Windows permission quirk：fallback 到 copy + rm
    try {
      cpSync(sourcePath, destPath, { recursive: true })
      rmSync(sourcePath, { recursive: true, force: true })
    } catch (fallbackErr) {
      rmSync(entryDir, { recursive: true, force: true })
      throw fallbackErr
    }
  }

  const meta: TrashMeta = {
    id,
    kind,
    originalPath: sourcePath,
    label,
    createdAt: Date.now(),
    sizeBytes: directorySize(destPath),
  }
  writeFileSync(join(entryDir, 'meta.json'), JSON.stringify(meta, null, 2))
  return meta
}

/** 讀 trash entry 的 meta。壞掉或不存在回 null。 */
export function readTrashMeta(cwd: string, id: string): TrashMeta | null {
  const metaPath = join(getTrashDir(cwd), id, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as TrashMeta
  } catch {
    return null
  }
}

/** 列出目前所有 trash entries（依 createdAt 新→舊）。 */
export function listTrash(cwd: string): TrashMeta[] {
  const dir = getTrashDir(cwd)
  if (!existsSync(dir)) return []
  const results: TrashMeta[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const meta = readTrashMeta(cwd, entry.name)
    if (meta) results.push(meta)
  }
  results.sort((a, b) => b.createdAt - a.createdAt)
  return results
}

/**
 * 從 trash 復原：把 payload/<name> 搬回 originalPath。
 * 若 originalPath 已存在會 throw（避免覆寫），除非 overwrite=true。
 * 成功後刪除 trash entry 目錄。
 */
export function restoreFromTrash(
  cwd: string,
  id: string,
  opts: { overwrite?: boolean } = {},
): TrashMeta {
  const meta = readTrashMeta(cwd, id)
  if (!meta) throw new Error(`restoreFromTrash: entry not found: ${id}`)
  const entryDir = join(getTrashDir(cwd), id)
  const payloadDir = join(entryDir, 'payload')
  const payloadName = basename(meta.originalPath)
  const payloadPath = join(payloadDir, payloadName)
  if (!existsSync(payloadPath)) {
    throw new Error(`restoreFromTrash: payload missing for ${id}`)
  }
  if (existsSync(meta.originalPath)) {
    if (!opts.overwrite) {
      throw new Error(
        `restoreFromTrash: destination exists: ${meta.originalPath}`,
      )
    }
    rmSync(meta.originalPath, { recursive: true, force: true })
  }
  mkdirSync(dirname(meta.originalPath), { recursive: true })
  try {
    renameSync(payloadPath, meta.originalPath)
  } catch {
    cpSync(payloadPath, meta.originalPath, { recursive: true })
    rmSync(payloadPath, { recursive: true, force: true })
  }
  rmSync(entryDir, { recursive: true, force: true })
  return meta
}

/** 永久刪除指定 trash entry。 */
export function purgeTrashEntry(cwd: string, id: string): void {
  const entryDir = join(getTrashDir(cwd), id)
  if (!existsSync(entryDir)) return
  rmSync(entryDir, { recursive: true, force: true })
}

/** 清空整個 trash。回傳被刪的 entry ids。 */
export function emptyTrash(cwd: string): string[] {
  const entries = listTrash(cwd)
  for (const meta of entries) {
    purgeTrashEntry(cwd, meta.id)
  }
  return entries.map(e => e.id)
}

/** 刪除 trash 中超過 N 天的 entries。回傳被刪 ids。 */
export function pruneTrash(cwd: string, olderThanDays: number): string[] {
  if (olderThanDays < 0) return []
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  const removed: string[] = []
  for (const meta of listTrash(cwd)) {
    if (meta.createdAt < threshold) {
      purgeTrashEntry(cwd, meta.id)
      removed.push(meta.id)
    }
  }
  return removed
}

/** 供人工 debug：以 bytes 單位回傳整個 trash 佔用大小。 */
export function totalTrashSize(cwd: string): number {
  const dir = getTrashDir(cwd)
  if (!existsSync(dir)) return 0
  return directorySize(dir)
}
