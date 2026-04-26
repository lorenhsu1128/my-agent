// M-MEMTUI-2-2：本機 mutation helpers — TUI 在 standalone mode（無 daemon）
// 直接呼叫；attached mode 的 daemon WS 路徑（Phase 3）也會復用同一組 helpers。
//
// 共五個 op：create / update / rename / delete / restore。注入掃描在 caller
// 那層先做（讓 TUI 能彈警告 + override），這裡只接受預先檢過的 input。

import { readFile, rename as renameAsync, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  acquireMemdirLock,
  atomicWrite,
  buildFileContent,
  updateMemoryIndex,
  validateMemoryFilename,
} from '../../memdir/memdirOps.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import type { MemoryType } from '../../memdir/memoryTypes.js'
import {
  softDeleteMemoryEntry,
  softDeleteStandaloneFile,
} from '../../utils/memoryDelete.js'
import type { MemoryEntry } from '../../utils/memoryList.js'

export type MutationResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

// ---------------- create ----------------

export async function createAutoMemory(input: {
  filename: string
  name: string
  description: string
  type: MemoryType
  body: string
}): Promise<MutationResult> {
  const memDir = getAutoMemPath()
  const v = validateMemoryFilename(input.filename, memDir)
  if (!v.ok) return { ok: false, error: v.error }
  if (existsSync(v.filePath)) {
    return { ok: false, error: `已存在：${input.filename}（用 e 編輯或 r 重命名）` }
  }
  const release = await acquireMemdirLock(memDir)
  try {
    const content = buildFileContent(
      input.name,
      input.description,
      input.type,
      input.body,
    )
    await atomicWrite(v.filePath, content)
    await updateMemoryIndex(
      'add',
      memDir,
      input.filename,
      input.name,
      input.description,
    )
    return { ok: true, message: `建立 ${input.filename}` }
  } finally {
    if (release) await release()
  }
}

export async function createLocalConfig(input: {
  cwd: string
  filename: string
  body: string
}): Promise<MutationResult> {
  const dir = join(input.cwd, '.my-agent')
  if (!input.filename.endsWith('.md')) {
    return { ok: false, error: 'filename 必須以 .md 結尾' }
  }
  if (/[/\\]/.test(input.filename) || input.filename.includes('..')) {
    return { ok: false, error: 'filename 不可含路徑分隔符或 ..' }
  }
  const target = join(dir, input.filename)
  if (existsSync(target)) {
    return { ok: false, error: `已存在：${input.filename}` }
  }
  await writeFile(target, input.body, 'utf-8')
  return { ok: true, message: `建立 ${input.filename}` }
}

// ---------------- update ----------------

export async function updateAutoMemory(input: {
  filename: string
  name: string
  description: string
  type: MemoryType
  body: string
}): Promise<MutationResult> {
  const memDir = getAutoMemPath()
  const v = validateMemoryFilename(input.filename, memDir)
  if (!v.ok) return { ok: false, error: v.error }
  if (!existsSync(v.filePath)) {
    return { ok: false, error: `不存在：${input.filename}` }
  }
  const release = await acquireMemdirLock(memDir)
  try {
    const content = buildFileContent(
      input.name,
      input.description,
      input.type,
      input.body,
    )
    await atomicWrite(v.filePath, content)
    await updateMemoryIndex(
      'replace',
      memDir,
      input.filename,
      input.name,
      input.description,
    )
    return { ok: true, message: `更新 ${input.filename}` }
  } finally {
    if (release) await release()
  }
}

/** 純 body 寫入（local-config / project / USER）— 不動 frontmatter / 索引 */
export async function writeRawBody(
  absolutePath: string,
  body: string,
): Promise<MutationResult> {
  try {
    await atomicWrite(absolutePath, body)
    return { ok: true, message: `寫入 ${absolutePath}` }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------- rename (auto-memory 與 local-config) ----------------

export async function renameAutoMemory(input: {
  oldFilename: string
  newFilename: string
}): Promise<MutationResult> {
  const memDir = getAutoMemPath()
  const oldV = validateMemoryFilename(input.oldFilename, memDir)
  if (!oldV.ok) return { ok: false, error: `舊檔名：${oldV.error}` }
  const newV = validateMemoryFilename(input.newFilename, memDir)
  if (!newV.ok) return { ok: false, error: `新檔名：${newV.error}` }
  if (input.oldFilename === input.newFilename) {
    return { ok: false, error: '新舊檔名相同' }
  }
  if (!existsSync(oldV.filePath)) {
    return { ok: false, error: `舊檔不存在：${input.oldFilename}` }
  }
  if (existsSync(newV.filePath)) {
    return { ok: false, error: `新檔已存在：${input.newFilename}` }
  }
  const release = await acquireMemdirLock(memDir)
  try {
    // 從舊檔讀 frontmatter 取 name + description（保留索引內容）
    const content = await readFile(oldV.filePath, 'utf-8')
    const fm = parseSimpleFrontmatter(content)

    await renameAsync(oldV.filePath, newV.filePath)
    // 索引：舊行刪除 + 新行加入
    await updateMemoryIndex('remove', memDir, input.oldFilename)
    if (fm.name && fm.description) {
      await updateMemoryIndex(
        'add',
        memDir,
        input.newFilename,
        fm.name,
        fm.description,
      )
    }
    return {
      ok: true,
      message: `${input.oldFilename} → ${input.newFilename}`,
    }
  } finally {
    if (release) await release()
  }
}

export async function renameLocalConfig(input: {
  cwd: string
  oldFilename: string
  newFilename: string
}): Promise<MutationResult> {
  if (!input.newFilename.endsWith('.md')) {
    return { ok: false, error: 'filename 必須以 .md 結尾' }
  }
  const dir = join(input.cwd, '.my-agent')
  const oldP = join(dir, input.oldFilename)
  const newP = join(dir, input.newFilename)
  if (!existsSync(oldP)) {
    return { ok: false, error: `舊檔不存在：${input.oldFilename}` }
  }
  if (existsSync(newP)) {
    return { ok: false, error: `新檔已存在：${input.newFilename}` }
  }
  await renameAsync(oldP, newP)
  return {
    ok: true,
    message: `${input.oldFilename} → ${input.newFilename}`,
  }
}

// ---------------- delete (soft) ----------------

export function deleteEntry(
  cwd: string,
  entry: MemoryEntry,
): MutationResult {
  try {
    if (entry.kind === 'auto-memory') {
      if (!entry.filename) throw new Error('auto-memory entry missing filename')
      softDeleteMemoryEntry({
        cwd,
        memDir: getAutoMemPath(),
        filename: entry.filename,
        details: {
          displayName: entry.displayName,
          description: entry.description,
          subKind: entry.kind,
        },
      })
      return { ok: true, message: `軟刪 ${entry.filename}（→ .trash/）` }
    }
    if (entry.kind === 'project-memory') {
      softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'project-memory',
        label: entry.displayName,
        details: {
          displayName: entry.displayName,
          description: entry.description,
          subKind: entry.kind,
        },
      })
      return { ok: true, message: `軟刪 ${entry.displayName}` }
    }
    if (entry.kind === 'local-config') {
      softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'project-memory',
        label: entry.displayName,
        details: {
          displayName: entry.displayName,
          description: entry.description,
          subKind: entry.kind,
        },
      })
      return { ok: true, message: `軟刪 ${entry.displayName}` }
    }
    if (entry.kind === 'daily-log') {
      softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'daily-log',
        label: entry.displayName,
        details: {
          displayName: entry.displayName,
          description: entry.description,
          subKind: entry.kind,
        },
      })
      return { ok: true, message: `軟刪 ${entry.displayName}` }
    }
    return { ok: false, error: `不支援刪除 kind: ${entry.kind}` }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------- 工具：抽 frontmatter 的 name / description ----------------

function parseSimpleFrontmatter(content: string): {
  name?: string
  description?: string
  type?: string
} {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = content.slice(3, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

/** 把 frontmatter + body 拆開（給 edit wizard 預填用） */
export async function readFileWithFrontmatter(
  absolutePath: string,
): Promise<{
  fm: { name?: string; description?: string; type?: string }
  body: string
  raw: string
}> {
  const raw = await readFile(absolutePath, 'utf-8')
  const fm = parseSimpleFrontmatter(raw)
  // 抽 body：去掉首個 frontmatter 區塊（與 logic.stripFrontmatter 邏輯相同）
  let body = raw
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end !== -1) {
      body = raw.slice(end + 4).replace(/^\n+/, '')
    }
  }
  return { fm, body, raw }
}
