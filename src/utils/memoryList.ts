/**
 * M-DELETE-5：列舉 memory 條目供 /memory-delete picker 顯示。
 * M-MEMTUI-1-1：加入 user-profile kind（global + project USER.md）。
 *
 * 五類：
 * 1. auto-memory  — getAutoMemPath() 的 .md 檔（排除 MEMORY.md）
 * 2. user-profile — ~/.my-agent/USER.md (global) + <slug>/USER.md (project)
 * 3. project-memory — 專案根目錄的 MY-AGENT.md（**非** CLAUDE.md，見 ADR-MD-02）
 * 4. local-config — 專案根目錄下 `.my-agent/*.md`
 * 5. daily-log    — auto-memory 下 `logs/YYYY/MM/*.md`
 *
 * 每個 entry 帶有：類別、顯示名、描述、絕對路徑、mtime。
 * picker 根據 kind 決定 delete / edit 分支。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { getAutoMemPath } from '../memdir/paths.js'
import {
  getUserModelGlobalPath,
  getUserModelProjectPath,
} from '../userModel/paths.js'
import { MEMORY_INDEX_FILENAME } from './memoryDelete.js'

export type MemoryEntryKind =
  | 'auto-memory'
  | 'user-profile'
  | 'project-memory'
  | 'local-config'
  | 'daily-log'

/** user-profile 的 sub-scope，picker 顯示用 */
export type UserProfileScope = 'global' | 'project'

export type MemoryEntry = {
  kind: MemoryEntryKind
  /** 顯示名稱（picker row 第一欄） */
  displayName: string
  /** 顯示描述（picker row 第二欄） */
  description: string
  /** 絕對路徑 */
  absolutePath: string
  /** 對應 memDir 的 filename（只 auto-memory 類有；其他 kind = undefined） */
  filename?: string
  /** 檔案 size bytes */
  sizeBytes: number
  /** mtime epoch ms */
  mtimeMs: number
  /** user-profile sub-scope（只 user-profile kind 有） */
  userProfileScope?: UserProfileScope
}

/** 簡單抽 YAML frontmatter（第一個 `---` 區塊）— 不 import 大型解析器。 */
function extractFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = content.slice(3, end).trim()
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

function tryStat(path: string): { sizeBytes: number; mtimeMs: number } | null {
  try {
    const st = statSync(path)
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function listAutoMemoryEntries(): MemoryEntry[] {
  let memDir: string
  try {
    memDir = getAutoMemPath()
  } catch {
    return []
  }
  if (!existsSync(memDir)) return []
  const results: MemoryEntry[] = []
  let entries: string[]
  try {
    entries = readdirSync(memDir)
  } catch {
    return []
  }
  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue
    if (filename === MEMORY_INDEX_FILENAME) continue
    const absolutePath = join(memDir, filename)
    const st = tryStat(absolutePath)
    if (!st || !statSync(absolutePath).isFile()) continue
    let fm: Record<string, string> = {}
    try {
      fm = extractFrontmatter(readFileSync(absolutePath, 'utf-8'))
    } catch {
      // 讀不了仍列出，fallback 用 filename
    }
    const type = fm.type ?? 'unknown'
    const name = fm.name ?? filename
    const description = fm.description ?? ''
    results.push({
      kind: 'auto-memory',
      displayName: `[${type}] ${name}`,
      description,
      absolutePath,
      filename,
      ...st,
    })
  }
  return results
}

function listUserProfiles(): MemoryEntry[] {
  const out: MemoryEntry[] = []
  const candidates: Array<{ scope: UserProfileScope; path: string }> = []
  try {
    candidates.push({ scope: 'global', path: getUserModelGlobalPath() })
  } catch {
    // 解析失敗 → 略過
  }
  try {
    candidates.push({ scope: 'project', path: getUserModelProjectPath() })
  } catch {
    // 同上
  }
  for (const { scope, path } of candidates) {
    const st = tryStat(path)
    if (!st) continue
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    out.push({
      kind: 'user-profile',
      displayName: `[user:${scope}] USER.md`,
      description: scope === 'global' ? '全域使用者建模' : '專案層使用者建模',
      absolutePath: path,
      sizeBytes: st.sizeBytes,
      mtimeMs: st.mtimeMs,
      userProfileScope: scope,
    })
  }
  return out
}

function listProjectMemory(cwd: string): MemoryEntry[] {
  // ADR-MD-02：my-agent 讀 MY-AGENT.md，不是 CLAUDE.md
  const target = join(cwd, 'MY-AGENT.md')
  const st = tryStat(target)
  if (!st) return []
  return [
    {
      kind: 'project-memory',
      displayName: '[project] MY-AGENT.md',
      description: '專案層指引（整檔）',
      absolutePath: target,
      ...st,
    },
  ]
}

function listLocalConfigs(cwd: string): MemoryEntry[] {
  const localDir = join(cwd, '.my-agent')
  if (!existsSync(localDir)) return []
  const out: MemoryEntry[] = []
  let entries: string[]
  try {
    entries = readdirSync(localDir)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const absolutePath = join(localDir, entry)
    const st = tryStat(absolutePath)
    if (!st) continue
    try {
      if (!statSync(absolutePath).isFile()) continue
    } catch {
      continue
    }
    out.push({
      kind: 'local-config',
      displayName: `[local] .my-agent/${entry}`,
      description: '專案本地設定',
      absolutePath,
      ...st,
    })
  }
  return out
}

function listDailyLogs(): MemoryEntry[] {
  let memDir: string
  try {
    memDir = getAutoMemPath()
  } catch {
    return []
  }
  const logsRoot = join(memDir, 'logs')
  if (!existsSync(logsRoot)) return []
  const out: MemoryEntry[] = []
  let years: string[]
  try {
    years = readdirSync(logsRoot)
  } catch {
    return []
  }
  for (const yyyy of years) {
    const yearDir = join(logsRoot, yyyy)
    let stYear
    try {
      stYear = statSync(yearDir)
    } catch {
      continue
    }
    if (!stYear.isDirectory()) continue
    let months: string[]
    try {
      months = readdirSync(yearDir)
    } catch {
      continue
    }
    for (const mm of months) {
      const monthDir = join(yearDir, mm)
      let stMonth
      try {
        stMonth = statSync(monthDir)
      } catch {
        continue
      }
      if (!stMonth.isDirectory()) continue
      let files: string[]
      try {
        files = readdirSync(monthDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const absolutePath = join(monthDir, f)
        const st = tryStat(absolutePath)
        if (!st) continue
        out.push({
          kind: 'daily-log',
          displayName: `[log] ${basename(f, '.md')}`,
          description: `daily log ${yyyy}/${mm}`,
          absolutePath,
          ...st,
        })
      }
    }
  }
  return out
}

/**
 * 列舉所有可刪除 / 編輯的 memory 條目，依 mtime 新→舊排序。
 * cwd = 目前專案根目錄（用於找 MY-AGENT.md / .my-agent/）
 */
export function listAllMemoryEntries(cwd: string): MemoryEntry[] {
  const all = [
    ...listAutoMemoryEntries(),
    ...listUserProfiles(),
    ...listProjectMemory(cwd),
    ...listLocalConfigs(cwd),
    ...listDailyLogs(),
  ]
  all.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return all
}
