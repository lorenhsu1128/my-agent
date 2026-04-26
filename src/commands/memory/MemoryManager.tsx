// M-MEMTUI-1-3 / Phase 1：MemoryManager 主 picker，read-only list/detail/viewer。
// Phase 2 補 mutation（create/edit/delete/rename）；Phase 3 補 daemon RPC；
// Phase 4 補輔助子畫面（session-index / trash）+ multi-delete alias 模式。

import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getCurrentDaemonManager } from '../../hooks/useDaemonMode.js'
import {
  listAllMemoryEntries,
  type MemoryEntry,
} from '../../utils/memoryList.js'
import { readFileSync } from 'fs'
import {
  TABS,
  type TabId,
  filterByKeyword,
  filterByTab,
  formatRelativeTime,
  nextTab,
  prevTab,
  previewBody,
  sortEntries,
  stripFrontmatter,
  truncate,
} from './memoryManagerLogic.js'

export type Props = {
  onExit: (summary: string) => void
}

type Mode = 'list' | 'detail' | 'filtering' | 'viewer'

type Flash = { text: string; tone: 'info' | 'error' }

const PREVIEW_LINES = 30
const VIEWER_PAGE_SIZE = 20

export function MemoryManager({ onExit }: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const [mode, setMode] = useState<Mode>('list')
  const [tab, setTab] = useState<TabId>('auto-memory')
  const [cursor, setCursor] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [allEntries, setAllEntries] = useState<MemoryEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [bodyContent, setBodyContent] = useState<string>('')
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [viewerOffset, setViewerOffset] = useState(0)

  const reload = (): void => setReloadToken(n => n + 1)

  // Load + 5s poll for external changes
  useEffect(() => {
    let cancelled = false
    function load(): void {
      try {
        const list = listAllMemoryEntries(cwd)
        if (!cancelled) {
          setAllEntries(list)
          setLoadError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [cwd, reloadToken])

  // Auto-clear flash after 2.5s
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  // Subscribe to daemon broadcasts — memory.itemsChanged → immediate reload.
  // Phase 1：只訂閱不送 mutation；Phase 3 接通寫入路徑。
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string }): void => {
      if (f.type === 'memory.itemsChanged') {
        setReloadToken(n => n + 1)
      }
    }
    mgr.on('frame', handler as never)
    return () => mgr.off('frame', handler as never)
  }, [])

  const tabRows = useMemo(() => {
    const tabFiltered = filterByTab(allEntries, tab)
    const filtered = filterByKeyword(tabFiltered, keyword)
    return sortEntries(filtered)
  }, [allEntries, tab, keyword])

  const safeCursor = Math.min(cursor, Math.max(0, tabRows.length - 1))
  const selected = tabRows[safeCursor]

  // Load body content when entering detail / viewer mode for selected entry.
  useEffect(() => {
    if (mode !== 'detail' && mode !== 'viewer') return
    if (!selected) {
      setBodyContent('')
      setBodyError('(no entry)')
      return
    }
    try {
      const content = readFileSync(selected.absolutePath, 'utf-8')
      setBodyContent(content)
      setBodyError(null)
    } catch (err) {
      setBodyContent('')
      setBodyError(err instanceof Error ? err.message : String(err))
    }
  }, [mode, selected])

  // Reset viewer scroll when entering / changing entry
  useEffect(() => {
    if (mode === 'viewer') setViewerOffset(0)
  }, [mode, selected])

  useInput((input, key) => {
    // Filtering mode: text input first
    if (mode === 'filtering') {
      if (key.escape || key.return) {
        setMode('list')
        return
      }
      if (key.backspace || key.delete) {
        setKeyword(k => k.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setKeyword(k => k + input)
      }
      return
    }

    // Viewer (full-screen body): scroll only
    if (mode === 'viewer') {
      if (key.escape || input === 'q' || input === 'V' || input === 'v') {
        setMode('detail')
        return
      }
      if (key.upArrow) {
        setViewerOffset(o => Math.max(0, o - 1))
        return
      }
      if (key.downArrow) {
        setViewerOffset(o => o + 1)
        return
      }
      if (key.pageUp) {
        setViewerOffset(o => Math.max(0, o - VIEWER_PAGE_SIZE))
        return
      }
      if (key.pageDown) {
        setViewerOffset(o => o + VIEWER_PAGE_SIZE)
        return
      }
      return
    }

    // Detail mode
    if (mode === 'detail') {
      if (key.escape || key.leftArrow || input === 'q') {
        setMode('list')
        return
      }
      if (input === 'V' || input === 'v') {
        setMode('viewer')
        return
      }
      // e / E / r / d 留給 Phase 2/4
      if (input === 'e' || input === 'E' || input === 'r' || input === 'd') {
        setFlash({
          text: `(Phase 2 待實作：${input})`,
          tone: 'info',
        })
        return
      }
      return
    }

    // List mode
    if (key.escape || input === 'q') {
      onExit('Memory manager closed')
      return
    }
    if (key.leftArrow) {
      setTab(prevTab(tab))
      setCursor(0)
      return
    }
    if (key.rightArrow) {
      setTab(nextTab(tab))
      setCursor(0)
      return
    }
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(tabRows.length - 1, c + 1))
      return
    }
    if (key.return) {
      if (!selected) {
        setFlash({ text: '(no entry to inspect)', tone: 'info' })
        return
      }
      setMode('detail')
      return
    }
    if (input === '/') {
      setMode('filtering')
      return
    }
    if (
      input === 'n' ||
      input === 'e' ||
      input === 'd' ||
      input === 'r' ||
      input === 'E' ||
      input === 'V' ||
      input === 's'
    ) {
      setFlash({
        text: `(Phase 2/4 待實作：${input})`,
        tone: 'info',
      })
      return
    }
  })

  // ---------- Render branches ----------

  if (mode === 'viewer') {
    return renderViewer({
      entry: selected,
      bodyContent,
      bodyError,
      viewerOffset,
    })
  }

  if (mode === 'detail') {
    return renderDetail({
      entry: selected,
      bodyContent,
      bodyError,
      flash,
    })
  }

  // list / filtering 共用
  return (
    <Box flexDirection="column">
      {renderTabHeader(tab)}
      {renderFilterRow(mode, keyword)}
      {loadError && (
        <Text color="red">load error: {loadError}</Text>
      )}
      {renderRows(tabRows, safeCursor)}
      {renderFooter(mode)}
      {flash && (
        <Box>
          <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function renderTabHeader(active: TabId): React.ReactNode {
  return (
    <Box>
      <Text bold>Memory · </Text>
      {TABS.map((t, i) => {
        const isActive = t.id === active
        return (
          <React.Fragment key={t.id}>
            {i > 0 && <Text dimColor>  </Text>}
            {isActive ? (
              <Text bold color="cyan">
                ‹ {t.label} ›
              </Text>
            ) : (
              <Text dimColor>{t.label}</Text>
            )}
          </React.Fragment>
        )
      })}
      <Text dimColor>    (←/→ 切 tab)</Text>
    </Box>
  )
}

function renderFilterRow(mode: Mode, keyword: string): React.ReactNode {
  const filtering = mode === 'filtering'
  return (
    <Box>
      <Text dimColor>Filter: </Text>
      <Text color={filtering ? 'cyan' : undefined}>
        {filtering ? `[${keyword}_]` : keyword || '(none)'}
      </Text>
    </Box>
  )
}

function renderRows(
  rows: MemoryEntry[],
  cursor: number,
): React.ReactNode {
  if (rows.length === 0) {
    return (
      <Box>
        <Text dimColor>(no entries in this tab)</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {rows.slice(0, 30).map((row, i) => {
        const isCur = i === cursor
        const ts = formatRelativeTime(row.mtimeMs)
        return (
          <Box key={row.absolutePath}>
            <Text color={isCur ? 'cyan' : undefined}>
              {isCur ? figures.pointer : ' '}
            </Text>
            <Text> {truncate(row.displayName, 40)}</Text>
            <Text dimColor>
              {row.description ? ` — ${truncate(row.description, 40)}` : ''}
            </Text>
            <Text dimColor>  {ts}</Text>
          </Box>
        )
      })}
      {rows.length > 30 && (
        <Text dimColor>…and {rows.length - 30} more（按 / 篩選）</Text>
      )}
    </Box>
  )
}

function renderFooter(mode: Mode): React.ReactNode {
  if (mode === 'filtering') {
    return (
      <Box marginTop={1}>
        <Text dimColor>Esc/Enter 結束篩選 · Backspace 退一字</Text>
      </Box>
    )
  }
  return (
    <Box marginTop={1}>
      <Text dimColor>
        ↑/↓ · ←/→ 切 tab · Enter detail · / filter · n new · e edit · r rename · d delete · s 輔助 · q quit
      </Text>
    </Box>
  )
}

function renderDetail({
  entry,
  bodyContent,
  bodyError,
  flash,
}: {
  entry: MemoryEntry | undefined
  bodyContent: string
  bodyError: string | null
  flash: Flash | null
}): React.ReactNode {
  if (!entry) {
    return (
      <Box flexDirection="column">
        <Text color="red">(no entry selected)</Text>
        <Text dimColor>← back</Text>
      </Box>
    )
  }
  const body = stripFrontmatter(bodyContent)
  const preview = previewBody(body, PREVIEW_LINES)
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{entry.displayName}</Text>
      </Box>
      {entry.description && (
        <Box>
          <Text dimColor>description: </Text>
          <Text>{entry.description}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>path: {entry.absolutePath}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {entry.sizeBytes} bytes · {formatRelativeTime(entry.mtimeMs)}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>── body preview (first {PREVIEW_LINES} lines) ──</Text>
      </Box>
      {bodyError ? (
        <Text color="red">read failed: {bodyError}</Text>
      ) : (
        <Box flexDirection="column">
          {preview.split('\n').map((line, i) => (
            <Text key={i}>{line || ' '}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          V 全螢幕 · e 編 frontmatter · E 編 body · r 重命名 · d 刪除 · ←/q 退回
        </Text>
      </Box>
      {flash && (
        <Box>
          <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function renderViewer({
  entry,
  bodyContent,
  bodyError,
  viewerOffset,
}: {
  entry: MemoryEntry | undefined
  bodyContent: string
  bodyError: string | null
  viewerOffset: number
}): React.ReactNode {
  if (!entry) {
    return (
      <Box flexDirection="column">
        <Text color="red">(no entry)</Text>
      </Box>
    )
  }
  if (bodyError) {
    return (
      <Box flexDirection="column">
        <Text color="red">read failed: {bodyError}</Text>
        <Text dimColor>q/V/Esc 退回 detail</Text>
      </Box>
    )
  }
  const lines = bodyContent.split('\n')
  const visible = lines.slice(
    viewerOffset,
    viewerOffset + 40,
  )
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">{entry.displayName}</Text>
        <Text dimColor>  (viewer · 行 {viewerOffset + 1}-{viewerOffset + visible.length} / {lines.length})</Text>
      </Box>
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ 行捲動 · PgUp/PgDn 翻頁 · q/V/Esc 退回 detail</Text>
      </Box>
    </Box>
  )
}
