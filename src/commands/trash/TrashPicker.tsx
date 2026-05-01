/**
 * M-DELETE-8：/trash picker。
 *
 * 列出 .trash/ 所有 entries，支援：
 *   Enter    永久刪除選中
 *   r        還原選中（restore）
 *   x        清空全部（雙段確認）
 *   p        prune N 天前（先進入輸入模式，完成後標選 → 確認 → 清）
 *   / filter / space / a / n 同其他 picker
 *
 * Restore 後 session 類仍需手動跑 reconciler 重建 FTS（目前先標明「需重啟或 /session-search 觸發」）。
 */
import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  listTrash,
  purgeTrashEntry,
  pruneTrash,
  emptyTrash,
  restoreFromTrash,
  totalTrashSize,
  type TrashMeta,
} from '../../utils/trash/index.js'

type Mode =
  | 'picking'
  | 'filtering'
  | 'prune-input'
  | 'confirm-delete'
  | 'confirm-restore'
  | 'confirm-empty'
  | 'running'
  | 'done'

type Props = {
  onExit: (summary: string) => void
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return '   0 B'
  if (bytes < 1024) return `${bytes.toString().padStart(4)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1).padStart(5)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1).padStart(5)} MB`
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return ''
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function formatCost(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  if (v < 0.01) return ` $${v.toFixed(3)}`
  return ` $${v.toFixed(2)}`
}

/**
 * 把 TrashMeta 組成豐富的顯示字串，格式類似 /session-delete / /memory-delete。
 * 優先用 details 凍結的資訊；沒 details 才 fallback 到 label。
 */
function buildRichLabel(meta: TrashMeta): {
  left: string
  right: string
} {
  const d = meta.details
  if (meta.kind === 'session') {
    const sub = d?.subKind === 'tool-results' ? 'tool-results' : 'transcript'
    const tag = `[session/${sub}]`
    if (d?.firstUserMessage) {
      const msg = truncate(d.firstUserMessage, 50)
      const count = d.messageCount ? ` msg=${d.messageCount}` : ''
      const cost = formatCost(d.estimatedCostUsd)
      return {
        left: `${tag} ${msg}`,
        right: `${count}${cost}`,
      }
    }
    const idShort = d?.sessionId ? d.sessionId.slice(0, 8) : ''
    return { left: `${tag} ${idShort || meta.label || meta.id}`, right: '' }
  }

  if (
    meta.kind === 'memory' ||
    meta.kind === 'project-memory' ||
    meta.kind === 'daily-log'
  ) {
    const tag = `[${d?.subKind ?? meta.kind}]`
    const display = d?.displayName ?? meta.label ?? ''
    const desc = d?.description ? ` — ${truncate(d.description, 50)}` : ''
    return { left: `${tag} ${display}${desc}`, right: '' }
  }

  // unknown kind → fallback
  return {
    left: `[${meta.kind}] ${meta.label ?? meta.id}`,
    right: '',
  }
}

export function TrashPicker({ onExit }: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const [keyword, setKeyword] = useState('')
  const [pruneDays, setPruneDays] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('picking')
  const [flash, setFlash] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const allEntries: TrashMeta[] = useMemo(() => {
    try {
      return listTrash(cwd)
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, refresh])

  const totalSize = useMemo(() => totalTrashSize(cwd), [cwd, refresh])

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return allEntries
    return allEntries.filter(
      e =>
        e.id.toLowerCase().includes(kw) ||
        (e.label?.toLowerCase().includes(kw) ?? false) ||
        e.kind.toLowerCase().includes(kw),
    )
  }, [allEntries, keyword])

  const safeCursor = Math.min(cursor, Math.max(0, rows.length - 1))

  const executeDelete = () => {
    setMode('running')
    Promise.resolve().then(() => {
      const ids = Array.from(selected)
      let ok = 0
      for (const id of ids) {
        try {
          purgeTrashEntry(cwd, id)
          ok++
        } catch {
          // ignore
        }
      }
      const summary = `Permanently deleted ${ok} / ${ids.length} trash entries`
      setResult(summary)
      setSelected(new Set())
      setRefresh(x => x + 1)
      setMode('picking')
      setFlash(summary)
    })
  }

  const executeRestore = () => {
    setMode('running')
    Promise.resolve().then(() => {
      const ids = Array.from(selected)
      let ok = 0
      const errors: string[] = []
      for (const id of ids) {
        try {
          restoreFromTrash(cwd, id)
          ok++
        } catch (err) {
          errors.push(
            `${id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      const summary =
        errors.length === 0
          ? `Restored ${ok} entries. Note: session FTS index will rebuild on next session search.`
          : `Restored ${ok} / ${ids.length}; errors:\n${errors.join('\n')}`
      setResult(summary)
      setSelected(new Set())
      setRefresh(x => x + 1)
      setMode('picking')
      setFlash(summary)
    })
  }

  const executeEmpty = () => {
    setMode('running')
    Promise.resolve().then(() => {
      const removed = emptyTrash(cwd)
      const summary = `Emptied ${removed.length} trash entries`
      setResult(summary)
      setSelected(new Set())
      setRefresh(x => x + 1)
      setMode('picking')
      setFlash(summary)
    })
  }

  useInput((input, key) => {
    if (mode === 'done' || mode === 'running') return

    if (mode === 'filtering' || mode === 'prune-input') {
      if (key.escape) {
        setMode('picking')
        if (mode === 'prune-input') setPruneDays('')
        return
      }
      if (key.return) {
        if (mode === 'prune-input') {
          const n = parseInt(pruneDays, 10)
          if (!Number.isFinite(n) || n < 0) {
            setFlash('天數格式錯誤。')
            setPruneDays('')
            setMode('picking')
            return
          }
          // 標記 N 天前的所有 entries
          const threshold = Date.now() - n * 86400000
          const toPrune = allEntries
            .filter(e => e.createdAt < threshold)
            .map(e => e.id)
          setSelected(new Set(toPrune))
          setPruneDays('')
          setMode('picking')
          setFlash(
            `Pre-selected ${toPrune.length} entries older than ${n} days. Enter to delete.`,
          )
          return
        }
        setMode('picking')
        return
      }
      if (key.backspace || key.delete) {
        if (mode === 'filtering') setKeyword(k => k.slice(0, -1))
        else setPruneDays(k => k.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        if (mode === 'filtering') setKeyword(k => k + input)
        else if (/[0-9]/.test(input)) setPruneDays(k => k + input)
        return
      }
      return
    }

    if (mode === 'confirm-delete') {
      if (key.escape) return setMode('picking')
      if (input === 'y' || input === 'Y') return executeDelete()
      return
    }
    if (mode === 'confirm-restore') {
      if (key.escape) return setMode('picking')
      if (input === 'y' || input === 'Y') return executeRestore()
      return
    }
    if (mode === 'confirm-empty') {
      if (key.escape) return setMode('picking')
      if (input === 'y' || input === 'Y') return executeEmpty()
      return
    }

    // picking
    if (key.escape) {
      onExit(result ?? '已關閉垃圾桶')
      return
    }
    if (key.upArrow) return setCursor(c => Math.max(0, c - 1))
    if (key.downArrow) return setCursor(c => Math.min(rows.length - 1, c + 1))
    if (input === '/') return setMode('filtering')
    if (input === ' ') {
      const row = rows[safeCursor]
      if (!row) return
      const next = new Set(selected)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      setSelected(next)
      return
    }
    if (input === 'a') return setSelected(new Set(rows.map(r => r.id)))
    if (input === 'n') return setSelected(new Set())
    if (input === 'r') {
      if (selected.size === 0) return setFlash('請選取要還原的項目。')
      return setMode('confirm-restore')
    }
    if (input === 'x') {
      if (allEntries.length === 0) return setFlash('垃圾桶已是空的。')
      return setMode('confirm-empty')
    }
    if (input === 'p') return setMode('prune-input')
    if (key.return) {
      if (selected.size === 0) return setFlash('未選取任何項目。')
      setMode('confirm-delete')
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
        <Text>Working…</Text>
      </Box>
    )
  }

  if (
    mode === 'confirm-delete' ||
    mode === 'confirm-restore' ||
    mode === 'confirm-empty'
  ) {
    const label =
      mode === 'confirm-delete'
        ? `Permanently delete ${selected.size} trash entries`
        : mode === 'confirm-restore'
          ? `Restore ${selected.size} trash entries to original paths`
          : `Empty ALL ${allEntries.length} trash entries`
    return (
      <Box flexDirection="column" gap={0}>
        <Text bold color="yellow">
          {label}
        </Text>
        <Text dimColor>This cannot be undone.</Text>
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
        <Text bold>Trash</Text>
        <Text dimColor>
          {' '}
          · {rows.length} shown · {selected.size} selected · total{' '}
          {formatSize(totalSize)}
        </Text>
      </Box>
      <Box>
        <Text dimColor>Filter: </Text>
        <Text color={mode === 'filtering' ? 'cyan' : undefined}>
          {mode === 'filtering' ? `[${keyword}_]` : keyword || '(none)'}
        </Text>
        {mode === 'prune-input' && (
          <>
            <Text dimColor> · Prune days: </Text>
            <Text color="cyan">[{pruneDays}_]</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>(trash is empty)</Text>}
        {rows.slice(0, 30).map((row, i) => {
          const isSel = selected.has(row.id)
          const isCur = i === safeCursor
          const mark = isSel ? '[✓]' : '[ ]'
          const color = isSel ? 'yellow' : undefined
          const rich = buildRichLabel(row)
          return (
            <Box key={row.id}>
              <Text color={isCur ? 'cyan' : undefined}>
                {isCur ? figures.pointer : ' '}
              </Text>
              <Text color={color}> {mark} </Text>
              <Text dimColor>{formatDate(row.createdAt)} </Text>
              <Text dimColor>{formatSize(row.sizeBytes)} </Text>
              <Text>{rich.left}</Text>
              <Text dimColor>{rich.right}</Text>
            </Box>
          )
        })}
        {rows.length > 30 && (
          <Text dimColor>…and {rows.length - 30} more (narrow with /)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · space · a/n · / filter · r restore · x empty · p prune · Enter
          delete · Esc close
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
