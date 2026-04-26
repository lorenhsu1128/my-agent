// M-MEMTUI Phase 4：Session-index 輔助畫面。
// 顯示 db 路徑 / 檔案大小 / indexed sessions 數，提供 R 鍵 rebuild。
//
// session-index.db 是 derived store（可由 session JSONL 重建）— TUI 不允許
// 編輯，只提供觀測 + 維運動作。

import * as React from 'react'
import { useEffect, useState } from 'react'
import { existsSync, statSync } from 'fs'
import { Box, Text, useInput } from '../../ink.js'
import {
  getSessionIndexPath,
  openSessionIndex,
  reconcileProjectIndex,
  type ReconcileStats,
} from '../../services/sessionIndex/index.js'

type Props = {
  cwd: string
  onExit: () => void
}

type Stats = {
  dbPath: string
  exists: boolean
  sizeBytes: number
  sessionCount: number
  messageCount: number
}

function readStats(cwd: string): Stats {
  const dbPath = getSessionIndexPath(cwd)
  if (!existsSync(dbPath)) {
    return {
      dbPath,
      exists: false,
      sizeBytes: 0,
      sessionCount: 0,
      messageCount: 0,
    }
  }
  let sizeBytes = 0
  try {
    sizeBytes = statSync(dbPath).size
  } catch {
    // ignore
  }
  let sessionCount = 0
  let messageCount = 0
  try {
    const db = openSessionIndex(cwd)
    const sRow = db
      .query<{ c: number }, []>('SELECT COUNT(*) as c FROM sessions')
      .get()
    sessionCount = sRow?.c ?? 0
    try {
      const mRow = db
        .query<{ c: number }, []>(
          'SELECT COUNT(*) as c FROM messages_fts',
        )
        .get()
      messageCount = mRow?.c ?? 0
    } catch {
      // FTS 表可能名字略有不同；不致命
    }
  } catch {
    // db 開啟失敗 — stats 顯 0，rebuild 仍可用
  }
  return { dbPath, exists: true, sizeBytes, sessionCount, messageCount }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function SessionIndexPanel({ cwd, onExit }: Props): React.ReactNode {
  const [stats, setStats] = useState<Stats>(() => readStats(cwd))
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState<ReconcileStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  function refresh(): void {
    setStats(readStats(cwd))
  }

  useEffect(() => {
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  useInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'q' || key.leftArrow) {
      onExit()
      return
    }
    if (input === 'R' || input === 'r') {
      setBusy(true)
      setError(null)
      void (async () => {
        try {
          const r = await reconcileProjectIndex(cwd)
          setLastResult(r)
          refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Session-index 維運</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>路徑：</Text>
        <Text>{stats.dbPath}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>狀態：</Text>
        {stats.exists ? (
          <Text color="green">existing · {formatBytes(stats.sizeBytes)}</Text>
        ) : (
          <Text color="yellow">不存在（尚未建立）</Text>
        )}
      </Box>
      <Box>
        <Text>indexed sessions：</Text>
        <Text bold>{stats.sessionCount}</Text>
        <Text dimColor>  · messages_fts：{stats.messageCount}</Text>
      </Box>
      {lastResult && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">上次 rebuild 結果：</Text>
          <Text dimColor>
            scanned={lastResult.sessionsScanned} · indexed=
            {lastResult.sessionsIndexed} · new={lastResult.newSessions} · msgs=
            {lastResult.messagesIndexed} · errors={lastResult.errors} · {lastResult.durationMs}ms
          </Text>
        </Box>
      )}
      {error && <Text color="red">err: {error}</Text>}
      <Box marginTop={1}>
        <Text dimColor>
          {busy
            ? 'rebuilding…（reconcileProjectIndex 進行中）'
            : 'R rebuild · ←/q/Esc 退回'}
        </Text>
      </Box>
    </Box>
  )
}
