/**
 * M-DELETE-6：/session-delete picker。
 *
 * 列出當前 project 的歷史 sessions，多選後軟刪除（搬到 .trash + 硬刪 DB 索引）。
 * 當前進行中的 session 標記 [current] 且 disabled。
 *
 * 操作：
 *   ↑/↓      移動
 *   space    toggle 選取
 *   a/n      全選 / 全不選
 *   1/2/3/0  時間範圍：今天 / 本週 / 本月 / 全部
 *   /        進入關鍵字輸入模式（Esc 離開）
 *   Enter    進入二段確認
 *   y        （確認頁）真正刪除
 *   Esc      取消
 */
import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import {
  listSessions,
  type SessionSummary,
} from '../../services/sessionIndex/index.js'
import { trashSession } from '../../utils/trash/sessionOps.js'

type Mode = 'picking' | 'filtering' | 'confirming' | 'running' | 'done'
type Range = 'today' | 'week' | 'month' | 'all'

type Props = {
  onExit: (summary: string) => void
}

function rangeSince(range: Range): number | undefined {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  switch (range) {
    case 'today':
      return now - 1 * day
    case 'week':
      return now - 7 * day
    case 'month':
      return now - 30 * day
    case 'all':
      return undefined
  }
}

function formatAge(startedAt: number): string {
  const diff = Date.now() - startedAt
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

function formatCost(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '     '
  if (v < 0.01) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

function truncate(s: string | null, n: number): string {
  if (!s) return ''
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

export function SessionDeletePicker({ onExit }: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const currentSessionId = getSessionId()
  const [range, setRange] = useState<Range>('all')
  const [keyword, setKeyword] = useState<string>('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('picking')
  const [flash, setFlash] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)

  const allRows: SessionSummary[] = useMemo(() => {
    try {
      return listSessions(cwd, {
        sinceMs: rangeSince(range),
        keyword: keyword.trim() || undefined,
        limit: 200,
      })
    } catch (err) {
      setFlash(
        `listSessions failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }, [cwd, range, keyword])

  const rows = allRows
  const safeCursor = Math.min(cursor, Math.max(0, rows.length - 1))

  useInput((input, key) => {
    if (mode === 'done' || mode === 'running') return

    if (mode === 'filtering') {
      if (key.escape || key.return) {
        setMode('picking')
        return
      }
      if (key.backspace || key.delete) {
        setKeyword(k => k.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setKeyword(k => k + input)
        return
      }
      return
    }

    if (mode === 'confirming') {
      if (key.escape) {
        setMode('picking')
        return
      }
      if (input === 'y' || input === 'Y') {
        setMode('running')
        // 延後執行讓 UI 有機會 render running 狀態
        Promise.resolve().then(() => {
          const ids = Array.from(selected)
          let okCount = 0
          const errors: string[] = []
          for (const id of ids) {
            try {
              trashSession(cwd, id)
              okCount++
            } catch (err) {
              errors.push(
                `${id}: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
          const summary =
            errors.length === 0
              ? `Soft-deleted ${okCount} session(s) to .trash/`
              : `Soft-deleted ${okCount} / ${ids.length}; ${errors.length} error(s):\n${errors.join('\n')}`
          setRunResult(summary)
          setMode('done')
          onExit(summary)
        })
        return
      }
      return
    }

    // picking mode
    if (key.escape) {
      onExit('Session delete cancelled (no changes)')
      return
    }
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(rows.length - 1, c + 1))
      return
    }
    if (input === '/') {
      setMode('filtering')
      return
    }
    if (input === '1') {
      setRange('today')
      setCursor(0)
      return
    }
    if (input === '2') {
      setRange('week')
      setCursor(0)
      return
    }
    if (input === '3') {
      setRange('month')
      setCursor(0)
      return
    }
    if (input === '0') {
      setRange('all')
      setCursor(0)
      return
    }
    if (input === ' ') {
      const row = rows[safeCursor]
      if (!row) return
      if (row.sessionId === currentSessionId) {
        setFlash('無法刪除目前 session。')
        return
      }
      const next = new Set(selected)
      if (next.has(row.sessionId)) next.delete(row.sessionId)
      else next.add(row.sessionId)
      setSelected(next)
      return
    }
    if (input === 'a') {
      const next = new Set<string>()
      for (const r of rows) {
        if (r.sessionId !== currentSessionId) next.add(r.sessionId)
      }
      setSelected(next)
      return
    }
    if (input === 'n') {
      setSelected(new Set())
      return
    }
    if (key.return) {
      if (selected.size === 0) {
        setFlash('未選取任何 session。')
        return
      }
      setMode('confirming')
      return
    }
  })

  if (mode === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">{runResult}</Text>
      </Box>
    )
  }

  if (mode === 'running') {
    return (
      <Box>
        <Text>Deleting {selected.size} session(s)…</Text>
      </Box>
    )
  }

  if (mode === 'confirming') {
    return (
      <Box flexDirection="column" gap={0}>
        <Text bold color="yellow">
          Confirm soft-delete of {selected.size} session(s) to .trash/
        </Text>
        <Text dimColor>
          DB FTS index rows will be hard-deleted; JSONL + tool-results go to
          .trash (restore via /trash).
        </Text>
        <Text>
          Press <Text bold>y</Text> to proceed, <Text bold>Esc</Text> to go
          back.
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={0}>
      <Box>
        <Text bold>Session Delete</Text>
        <Text dimColor>
          {' '}
          · {rows.length} shown · {selected.size} selected
        </Text>
      </Box>
      <Box>
        <Text dimColor>Range: </Text>
        <Text color={range === 'today' ? 'cyan' : undefined}>1=today </Text>
        <Text color={range === 'week' ? 'cyan' : undefined}>2=week </Text>
        <Text color={range === 'month' ? 'cyan' : undefined}>3=month </Text>
        <Text color={range === 'all' ? 'cyan' : undefined}>0=all</Text>
        <Text dimColor> · Filter: </Text>
        <Text color={mode === 'filtering' ? 'cyan' : undefined}>
          {mode === 'filtering' ? `[${keyword}_]` : keyword || '(none)'}
        </Text>
      </Box>
      <Box flexDirection="column">
        {rows.length === 0 && (
          <Text dimColor>(no sessions match current filter)</Text>
        )}
        {rows.slice(0, 30).map((row, i) => {
          const isSelected = selected.has(row.sessionId)
          const isCurrent = row.sessionId === currentSessionId
          const isCursor = i === safeCursor
          const mark = isCurrent
            ? '[cur]'
            : isSelected
              ? '[✓]'
              : '[ ]'
          const color = isCurrent
            ? 'gray'
            : isSelected
              ? 'yellow'
              : undefined
          return (
            <Box key={row.sessionId}>
              <Text color={isCursor ? 'cyan' : undefined}>
                {isCursor ? figures.pointer : ' '}
              </Text>
              <Text color={color}> {mark} </Text>
              <Text dimColor>{formatAge(row.startedAt).padEnd(8)} </Text>
              <Text dimColor>
                msg={String(row.messageCount).padStart(3)}
              </Text>
              <Text dimColor>{formatCost(row.estimatedCostUsd)} </Text>
              <Text>{truncate(row.firstUserMessage, 50)}</Text>
            </Box>
          )
        })}
        {rows.length > 30 && (
          <Text dimColor>…and {rows.length - 30} more (narrow with /)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · space toggle · a all · n none · 1/2/3/0 range · / filter · Enter
          confirm · Esc cancel
        </Text>
      </Box>
      {flash && (
        <Box>
          <Text color="yellow">{flash}</Text>
        </Box>
      )}
    </Box>
  )
}
