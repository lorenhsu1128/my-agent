// M-MEMTUI-1-2：memoryManagerLogic 純函式單元測試（無 Ink harness）。

import { describe, expect, test } from 'bun:test'
import {
  TABS,
  filterByKeyword,
  filterByTab,
  formatRelativeTime,
  getTab,
  nextTab,
  prevTab,
  previewBody,
  sortEntries,
  stripFrontmatter,
  tabIdOfEntry,
  truncate,
} from '../../../src/commands/memory/memoryManagerLogic.js'
import type { MemoryEntry } from '../../../src/utils/memoryList.js'

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    kind: 'auto-memory',
    displayName: '[feedback] foo.md',
    description: 'desc',
    absolutePath: '/tmp/memdir/foo.md',
    filename: 'foo.md',
    sizeBytes: 100,
    mtimeMs: 1_000_000,
    ...over,
  }
}

describe('TABS spec', () => {
  test('5 個 tab，順序固定', () => {
    expect(TABS.map(t => t.id)).toEqual([
      'auto-memory',
      'user-profile',
      'project',
      'local-config',
      'daily-log',
    ])
  })

  test('能力矩陣：USER tab 不可刪、不可重命名、不可建', () => {
    const t = getTab('user-profile')
    expect(t.canCreate).toBe(false)
    expect(t.canDelete).toBe(false)
    expect(t.canRename).toBe(false)
    expect(t.canEditBody).toBe(true)
    expect(t.canEditFrontmatter).toBe(false)
  })

  test('能力矩陣：daily-log tab 全唯讀（除可刪）', () => {
    const t = getTab('daily-log')
    expect(t.canCreate).toBe(false)
    expect(t.canEditBody).toBe(false)
    expect(t.canEditFrontmatter).toBe(false)
    expect(t.canRename).toBe(false)
    expect(t.canDelete).toBe(true)
  })

  test('能力矩陣：auto-memory tab 全功能', () => {
    const t = getTab('auto-memory')
    expect(t.canCreate).toBe(true)
    expect(t.canDelete).toBe(true)
    expect(t.canRename).toBe(true)
    expect(t.canEditBody).toBe(true)
    expect(t.canEditFrontmatter).toBe(true)
  })

  test('能力矩陣：local-config 可建/編 body/重命名/刪、無 frontmatter', () => {
    const t = getTab('local-config')
    expect(t.canCreate).toBe(true)
    expect(t.canEditFrontmatter).toBe(false)
    expect(t.canEditBody).toBe(true)
    expect(t.canRename).toBe(true)
    expect(t.canDelete).toBe(true)
  })
})

describe('tab cycle', () => {
  test('nextTab 循環 5 個', () => {
    expect(nextTab('auto-memory')).toBe('user-profile')
    expect(nextTab('user-profile')).toBe('project')
    expect(nextTab('project')).toBe('local-config')
    expect(nextTab('local-config')).toBe('daily-log')
    expect(nextTab('daily-log')).toBe('auto-memory')
  })

  test('prevTab 反向循環', () => {
    expect(prevTab('auto-memory')).toBe('daily-log')
    expect(prevTab('daily-log')).toBe('local-config')
    expect(prevTab('user-profile')).toBe('auto-memory')
  })
})

describe('tabIdOfEntry', () => {
  test('auto-memory entry → auto-memory tab', () => {
    expect(tabIdOfEntry(entry({ kind: 'auto-memory' }))).toBe('auto-memory')
  })

  test('user-profile entry → user-profile tab', () => {
    expect(tabIdOfEntry(entry({ kind: 'user-profile' }))).toBe('user-profile')
  })

  test('project-memory entry → project tab', () => {
    expect(tabIdOfEntry(entry({ kind: 'project-memory' }))).toBe('project')
  })

  test('daily-log entry → daily-log tab', () => {
    expect(tabIdOfEntry(entry({ kind: 'daily-log' }))).toBe('daily-log')
  })
})

describe('filterByTab', () => {
  const all = [
    entry({ kind: 'auto-memory', displayName: 'a' }),
    entry({ kind: 'user-profile', displayName: 'u' }),
    entry({ kind: 'project-memory', displayName: 'p' }),
    entry({ kind: 'local-config', displayName: 'l' }),
    entry({ kind: 'daily-log', displayName: 'd' }),
  ]

  test('每個 tab 只回對應 kind', () => {
    expect(filterByTab(all, 'auto-memory').map(e => e.displayName)).toEqual(['a'])
    expect(filterByTab(all, 'user-profile').map(e => e.displayName)).toEqual(['u'])
    expect(filterByTab(all, 'project').map(e => e.displayName)).toEqual(['p'])
    expect(filterByTab(all, 'local-config').map(e => e.displayName)).toEqual(['l'])
    expect(filterByTab(all, 'daily-log').map(e => e.displayName)).toEqual(['d'])
  })
})

describe('filterByKeyword', () => {
  const list = [
    entry({ displayName: 'feedback_alpha.md', description: 'first item' }),
    entry({ displayName: 'project_beta.md', description: 'second' }),
    entry({ displayName: 'gamma.md', description: 'alpha override' }),
  ]

  test('空字串 → 全傳回', () => {
    expect(filterByKeyword(list, '').length).toBe(3)
    expect(filterByKeyword(list, '   ').length).toBe(3)
  })

  test('match displayName 或 description', () => {
    const out = filterByKeyword(list, 'alpha')
    expect(out.length).toBe(2)
    expect(out.map(e => e.displayName).sort()).toEqual([
      'feedback_alpha.md',
      'gamma.md',
    ])
  })

  test('case-insensitive', () => {
    expect(filterByKeyword(list, 'BETA').length).toBe(1)
  })

  test('match path', () => {
    const out = filterByKeyword(list, 'tmp/memdir')
    expect(out.length).toBe(3)
  })
})

describe('sortEntries', () => {
  test('mtime 新→舊', () => {
    const arr = [
      entry({ displayName: 'old', mtimeMs: 100 }),
      entry({ displayName: 'mid', mtimeMs: 500 }),
      entry({ displayName: 'new', mtimeMs: 1000 }),
    ]
    expect(sortEntries(arr).map(e => e.displayName)).toEqual(['new', 'mid', 'old'])
  })

  test('不 mutate input', () => {
    const arr = [entry({ mtimeMs: 1 }), entry({ mtimeMs: 2 })]
    const order = arr.map(e => e.mtimeMs)
    sortEntries(arr)
    expect(arr.map(e => e.mtimeMs)).toEqual(order)
  })
})

describe('truncate', () => {
  test('短於 max 不動', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  test('長於 max 加 …', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('formatRelativeTime', () => {
  const now = 10_000_000_000
  test('s/m/h/d 切換', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('30s ago')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe('2d ago')
  })

  test('未來時間（負 delta）clamp 到 0', () => {
    expect(formatRelativeTime(now + 1000, now)).toBe('0s ago')
  })
})

describe('previewBody', () => {
  test('行數不超過 → 原樣', () => {
    expect(previewBody('a\nb\nc', 5)).toBe('a\nb\nc')
  })

  test('行數超過 → 截斷 + 提示', () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const out = previewBody(body, 10)
    expect(out.split('\n').length).toBe(11) // 10 + 提示行
    expect(out).toContain('40 more lines')
  })
})

describe('stripFrontmatter', () => {
  test('帶 frontmatter → 抽出 body', () => {
    const content = `---
name: foo
description: bar
---

real body line
second line`
    expect(stripFrontmatter(content)).toBe('real body line\nsecond line')
  })

  test('無 frontmatter → 原樣', () => {
    expect(stripFrontmatter('hello\nworld')).toBe('hello\nworld')
  })

  test('frontmatter 無收尾 → 原樣', () => {
    expect(stripFrontmatter('---\nincomplete')).toBe('---\nincomplete')
  })
})
