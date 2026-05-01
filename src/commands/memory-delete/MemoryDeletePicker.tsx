/**
 * M-DELETE-7：/memory-delete picker。
 *
 * 列出 auto-memory 條目、MY-AGENT.md、./.my-agent/*.md、daily logs；
 * 支援多選後軟刪除（搬到 .trash/）；游標列可按 `e` 直接 spawn $EDITOR 編輯。
 *
 * 操作：
 *   ↑/↓      移動
 *   space    toggle 選取
 *   a / n    全選 / 全不選
 *   /        進入關鍵字輸入模式
 *   e        編輯游標列（spawn $EDITOR，single-item action）
 *   Enter    進入二段確認刪除
 *   y        確認刪除
 *   Esc      取消
 */
import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  listAllMemoryEntries,
  type MemoryEntry,
} from '../../utils/memoryList.js'
import {
  softDeleteMemoryEntry,
  softDeleteStandaloneFile,
} from '../../utils/memoryDelete.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { spawn } from 'child_process'

type Mode = 'picking' | 'filtering' | 'confirming' | 'running' | 'done'

type Props = {
  onExit: (summary: string) => void
}

function pickEditor(): string {
  return (
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi')
  )
}

function deleteEntry(cwd: string, entry: MemoryEntry): { trashId: string } {
  const details = {
    displayName: entry.displayName,
    description: entry.description,
    subKind: entry.kind,
  }
  switch (entry.kind) {
    case 'auto-memory':
      if (!entry.filename) throw new Error('auto-memory entry missing filename')
      return softDeleteMemoryEntry({
        cwd,
        memDir: getAutoMemPath(),
        filename: entry.filename,
        details,
      })
    case 'project-memory':
      return softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'project-memory',
        label: entry.displayName,
        details,
      })
    case 'local-config':
      return softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'project-memory',
        label: entry.displayName,
        details,
      })
    case 'daily-log':
      return softDeleteStandaloneFile({
        cwd,
        sourcePath: entry.absolutePath,
        kind: 'daily-log',
        label: entry.displayName,
        details,
      })
  }
}

export function MemoryDeletePicker({ onExit }: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const [keyword, setKeyword] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('picking')
  const [flash, setFlash] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const allEntries = useMemo(() => {
    try {
      return listAllMemoryEntries(cwd)
    } catch (err) {
      setFlash(
        `list memory failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, refresh])

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return allEntries
    return allEntries.filter(
      e =>
        e.displayName.toLowerCase().includes(kw) ||
        e.description.toLowerCase().includes(kw) ||
        e.absolutePath.toLowerCase().includes(kw),
    )
  }, [allEntries, keyword])

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
        Promise.resolve().then(() => {
          const keys = Array.from(selected)
          let ok = 0
          const errors: string[] = []
          const map = new Map(allEntries.map(e => [e.absolutePath, e]))
          for (const p of keys) {
            const entry = map.get(p)
            if (!entry) {
              errors.push(`${p}: not found in listing`)
              continue
            }
            try {
              deleteEntry(cwd, entry)
              ok++
            } catch (err) {
              errors.push(
                `${p}: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
          const summary =
            errors.length === 0
              ? `Soft-deleted ${ok} memory item(s) to .trash/`
              : `Soft-deleted ${ok} / ${keys.length}; ${errors.length} error(s):\n${errors.join('\n')}`
          setResult(summary)
          setMode('done')
          onExit(summary)
        })
        return
      }
      return
    }

    // picking
    if (key.escape) {
      onExit('Memory delete cancelled (no changes)')
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
    if (input === ' ') {
      const row = rows[safeCursor]
      if (!row) return
      const next = new Set(selected)
      if (next.has(row.absolutePath)) next.delete(row.absolutePath)
      else next.add(row.absolutePath)
      setSelected(next)
      return
    }
    if (input === 'a') {
      setSelected(new Set(rows.map(r => r.absolutePath)))
      return
    }
    if (input === 'n') {
      setSelected(new Set())
      return
    }
    if (input === 'e') {
      const row = rows[safeCursor]
      if (!row) return
      const editor = pickEditor()
      try {
        const child = spawn(editor, [row.absolutePath], {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        })
        child.on('close', () => {
          setRefresh(x => x + 1)
          setFlash(`Edited ${row.displayName}`)
        })
        child.on('error', err => {
          setFlash(`editor error: ${err.message}`)
        })
      } catch (err) {
        setFlash(
          `editor spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return
    }
    if (key.return) {
      if (selected.size === 0) {
        setFlash('未選取任何項目。')
        return
      }
      setMode('confirming')
      return
    }
  })

  if (mode === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">{result}</Text>
      </Box>
    )
  }

  if (mode === 'running') {
    return (
      <Box>
        <Text>Deleting {selected.size} item(s)…</Text>
      </Box>
    )
  }

  if (mode === 'confirming') {
    return (
      <Box flexDirection="column" gap={0}>
        <Text bold color="yellow">
          Confirm soft-delete of {selected.size} memory item(s) to .trash/
        </Text>
        <Text dimColor>
          MEMORY.md index lines for auto-memory entries will be removed. Files
          move to .trash (restore via /trash).
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
        <Text bold>Memory Delete</Text>
        <Text dimColor>
          {' '}
          · {rows.length} shown · {selected.size} selected
        </Text>
      </Box>
      <Box>
        <Text dimColor>Filter: </Text>
        <Text color={mode === 'filtering' ? 'cyan' : undefined}>
          {mode === 'filtering' ? `[${keyword}_]` : keyword || '(none)'}
        </Text>
      </Box>
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>(no memory items)</Text>}
        {rows.slice(0, 30).map((row, i) => {
          const isSel = selected.has(row.absolutePath)
          const isCur = i === safeCursor
          const mark = isSel ? '[✓]' : '[ ]'
          const color = isSel ? 'yellow' : undefined
          return (
            <Box key={row.absolutePath}>
              <Text color={isCur ? 'cyan' : undefined}>
                {isCur ? figures.pointer : ' '}
              </Text>
              <Text color={color}> {mark} </Text>
              <Text>{row.displayName}</Text>
              <Text dimColor>
                {row.description ? ` — ${row.description}` : ''}
              </Text>
            </Box>
          )
        })}
        {rows.length > 30 && (
          <Text dimColor>…and {rows.length - 30} more (narrow with /)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · space toggle · a all · n none · / filter · e edit · Enter
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
