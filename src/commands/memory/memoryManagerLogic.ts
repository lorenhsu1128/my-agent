// M-MEMTUI-1-2：MemoryManager 的純函式邏輯，抽出讓單元測試不必開 Ink harness。
// 唯一消費者是 MemoryManager.tsx — 不要在 /commands/memory 外 re-export。

import type { MemoryEntry, MemoryEntryKind } from '../../utils/memoryList.js'

export type TabId =
  | 'auto-memory'
  | 'user-profile'
  | 'project'
  | 'local-config'
  | 'daily-log'

export type TabSpec = {
  id: TabId
  label: string
  /** 此 tab 篩選條件對應的 MemoryEntry.kind */
  kinds: ReadonlyArray<MemoryEntryKind>
  /** 可否在此 tab 從零新建 entry */
  canCreate: boolean
  /** 可否 inline 編輯 frontmatter（USER / project / local-config / daily-log 不適用） */
  canEditFrontmatter: boolean
  /** 可否編輯 body（daily-log 唯讀） */
  canEditBody: boolean
  /** 可否重命名（USER / project 路徑固定） */
  canRename: boolean
  /** 可否刪除（USER 不該刪） */
  canDelete: boolean
}

export const TABS: ReadonlyArray<TabSpec> = [
  {
    id: 'auto-memory',
    label: 'auto-memory',
    kinds: ['auto-memory'],
    canCreate: true,
    canEditFrontmatter: true,
    canEditBody: true,
    canRename: true,
    canDelete: true,
  },
  {
    id: 'user-profile',
    label: 'USER',
    kinds: ['user-profile'],
    canCreate: false,
    canEditFrontmatter: false,
    canEditBody: true,
    canRename: false,
    canDelete: false,
  },
  {
    id: 'project',
    label: 'project',
    kinds: ['project-memory'],
    canCreate: false,
    canEditFrontmatter: false,
    canEditBody: true,
    canRename: false,
    canDelete: true,
  },
  {
    id: 'local-config',
    label: 'local-config',
    kinds: ['local-config'],
    canCreate: true,
    canEditFrontmatter: false,
    canEditBody: true,
    canRename: true,
    canDelete: true,
  },
  {
    id: 'daily-log',
    label: 'daily-log',
    kinds: ['daily-log'],
    canCreate: false,
    canEditFrontmatter: false,
    canEditBody: false,
    canRename: false,
    canDelete: true,
  },
]

export function getTab(id: TabId): TabSpec {
  const t = TABS.find(t => t.id === id)
  if (!t) throw new Error(`unknown tab id: ${id}`)
  return t
}

export function nextTab(current: TabId): TabId {
  const idx = TABS.findIndex(t => t.id === current)
  return TABS[(idx + 1) % TABS.length]!.id
}

export function prevTab(current: TabId): TabId {
  const idx = TABS.findIndex(t => t.id === current)
  return TABS[(idx - 1 + TABS.length) % TABS.length]!.id
}

/** 此 entry 屬於哪個 tab — 反查讓 multi-delete 模式可以從 entry 反推 tab。 */
export function tabIdOfEntry(e: MemoryEntry): TabId {
  for (const t of TABS) {
    if (t.kinds.includes(e.kind)) return t.id
  }
  throw new Error(`no tab for kind: ${e.kind}`)
}

export function filterByTab(
  entries: ReadonlyArray<MemoryEntry>,
  tab: TabId,
): MemoryEntry[] {
  const spec = getTab(tab)
  return entries.filter(e => spec.kinds.includes(e.kind))
}

export function filterByKeyword(
  entries: ReadonlyArray<MemoryEntry>,
  keyword: string,
): MemoryEntry[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return [...entries]
  return entries.filter(
    e =>
      e.displayName.toLowerCase().includes(kw) ||
      e.description.toLowerCase().includes(kw) ||
      e.absolutePath.toLowerCase().includes(kw),
  )
}

/** 排序：mtime 新→舊（與 listAllMemoryEntries 一致；保留以便未來分組調整）。 */
export function sortEntries(entries: ReadonlyArray<MemoryEntry>): MemoryEntry[] {
  return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars - 1) + '…'
}

export function formatRelativeTime(
  mtimeMs: number,
  nowMs: number = Date.now(),
): string {
  const ago = Math.max(0, nowMs - mtimeMs)
  const sec = Math.floor(ago / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

/** 把 body 切前 N 行給 detail view 預覽用。 */
export function previewBody(body: string, maxLines: number): string {
  const lines = body.split('\n')
  if (lines.length <= maxLines) return body
  return lines.slice(0, maxLines).join('\n') + `\n…（${lines.length - maxLines} more lines）`
}

/** 從含 frontmatter 的整檔內容抽 body（去掉首個 `---` ... `---` 區塊）。 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content
  // 跳過 `\n---` (4 chars) + 後續任意數量的換行
  return content.slice(end + 4).replace(/^\n+/, '')
}
