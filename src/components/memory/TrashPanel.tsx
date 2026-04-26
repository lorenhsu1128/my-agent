// M-MEMTUI Phase 4：Trash 輔助畫面。
// 列 .trash/<id>/meta.json，提供 R 鍵還原（restoreFromTrash）。
// purge / empty 不在 TUI scope（避免不可逆操作走 TUI）；如需請走 /trash 命令。

import figures from 'figures'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  listTrash,
  restoreFromTrash,
  type TrashMeta,
} from '../../utils/trash/index.js'

type Props = {
  cwd: string
  onExit: () => void
}

type Flash = { text: string; tone: 'info' | 'error' }

function formatRelative(ms: number, nowMs: number = Date.now()): string {
  const ago = Math.max(0, nowMs - ms)
  const sec = Math.floor(ago / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export function TrashPanel({ cwd, onExit }: Props): React.ReactNode {
  const [items, setItems] = useState<TrashMeta[]>(() => listTrash(cwd))
  const [cursor, setCursor] = useState(0)
  const [flash, setFlash] = useState<Flash | null>(null)

  function refresh(): void {
    setItems(listTrash(cwd))
  }

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  useEffect(() => {
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const safeCursor = Math.min(cursor, Math.max(0, items.length - 1))
  const selected = items[safeCursor]

  useInput((input, key) => {
    if (key.escape || input === 'q' || key.leftArrow) {
      onExit()
      return
    }
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(items.length - 1, c + 1))
      return
    }
    if (input === 'R' || input === 'r') {
      if (!selected) {
        setFlash({ text: '無項目可還原', tone: 'error' })
        return
      }
      try {
        restoreFromTrash(cwd, selected.id)
        setFlash({ text: `已還原 ${selected.label}`, tone: 'info' })
        refresh()
      } catch (err) {
        setFlash({
          text: `restore fail: ${err instanceof Error ? err.message : String(err)}`,
          tone: 'error',
        })
      }
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Trash · {items.length} 個項目</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>(.trash/ 空)</Text>
        ) : (
          items.slice(0, 30).map((m, i) => {
            const isCur = i === safeCursor
            return (
              <Box key={m.id}>
                <Text color={isCur ? 'cyan' : undefined}>
                  {isCur ? figures.pointer : ' '}
                </Text>
                <Text> [{m.kind}] </Text>
                <Text>{m.label}</Text>
                <Text dimColor>  {formatRelative(m.createdAt)}</Text>
              </Box>
            )
          })
        )}
        {items.length > 30 && (
          <Text dimColor>…and {items.length - 30} more（用 /trash 命令看完整）</Text>
        )}
      </Box>
      {selected && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>原路徑：{selected.originalPath}</Text>
          <Text dimColor>id：{selected.id}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ · R 還原 · ←/q/Esc 退回</Text>
      </Box>
      {flash && (
        <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
          {flash.text}
        </Text>
      )}
    </Box>
  )
}
