// M-CRON-W3-7：StatusLine 內的 cron 持久 badge。讀 AppState.lastCronFire（由
// REPL.tsx 的 onCronFireEvent 寫入）渲染最後一次 fire 的簡要狀態。5 分鐘 TTL：
// 過期後不再顯示，等下次 fire 重新點亮。
//
// 沒有 useEffect 排程的 timer — 改用 Date.now() vs at 比對，每次 render 自動算。

import React from 'react'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'

const TTL_MS = 5 * 60_000

export function CronStatusBadge(): React.ReactElement | null {
  const last = useAppState(s => s.lastCronFire)
  if (!last) return null
  if (Date.now() - last.at > TTL_MS) return null

  const icon =
    last.status === 'completed'
      ? '✓'
      : last.status === 'failed'
        ? '✗'
        : last.status === 'retrying'
          ? '↻'
          : last.status === 'skipped'
            ? '↷'
            : '⏰'
  const color =
    last.status === 'failed'
      ? 'red'
      : last.status === 'retrying'
        ? 'yellow'
        : last.status === 'skipped'
          ? 'gray'
          : 'green'

  const label = last.taskName ?? last.taskId.slice(0, 6)
  return (
    <Box>
      <Text dimColor>cron </Text>
      <Text color={color}>{icon}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  )
}
