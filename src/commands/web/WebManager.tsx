// M-WEB-7：`/web` master TUI（Phase 1 minimal — Status tab + 動作鍵）。
// Phase 2+ 會擴成 2-tab（Status / Config）+ 即時 polling，沿用 LlamacppManager pattern。

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  getCurrentDaemonManager,
  sendWebControlToDaemon,
} from '../../hooks/useDaemonMode.js'
import { openBrowser } from '../../utils/browser.js'
import type { WebControlStatus } from '../../repl/thinClient/fallbackManager.js'

type Flash = { text: string; tone: 'info' | 'error' }

export type Props = {
  onExit: (summary: string) => void
}

export function WebManager({ onExit }: Props): React.ReactNode {
  const [status, setStatus] = useState<WebControlStatus>({ running: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setBusy('status')
    const r = await sendWebControlToDaemon('status', 5_000)
    setBusy(null)
    if (r === null) {
      setError('daemon 未啟動或未 attached')
      return
    }
    setError(null)
    setStatus(r.status)
  }

  useEffect(() => {
    void refresh()
  }, [])

  // 訂閱 daemon web.statusChanged → 自動更新
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string }): void => {
      if (f.type === 'web.statusChanged') {
        void refresh()
      }
    }
    mgr.on('frame', handler as never)
    return () => mgr.off('frame', handler as never)
  }, [])

  // Auto-clear flash
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  async function doStart(): Promise<void> {
    setBusy('start')
    const r = await sendWebControlToDaemon('start', 30_000)
    setBusy(null)
    if (r === null) {
      setFlash({ text: 'daemon 未 attached', tone: 'error' })
      return
    }
    if (!r.ok) {
      setFlash({ text: `start 失敗：${r.error}`, tone: 'error' })
      setStatus(r.status ?? { running: false })
      return
    }
    setStatus(r.status)
    setFlash({ text: `已啟動 :${r.status.port}`, tone: 'info' })
  }

  async function doStop(): Promise<void> {
    setBusy('stop')
    const r = await sendWebControlToDaemon('stop', 10_000)
    setBusy(null)
    if (r === null) {
      setFlash({ text: 'daemon 未 attached', tone: 'error' })
      return
    }
    if (!r.ok) {
      setFlash({ text: `stop 失敗：${r.error}`, tone: 'error' })
      return
    }
    setStatus(r.status)
    setFlash({ text: 'web server 已停止', tone: 'info' })
  }

  async function doOpen(): Promise<void> {
    if (!status.running || !status.urls?.length) {
      setFlash({ text: '尚未啟動 — 按 s 啟動', tone: 'error' })
      return
    }
    const url =
      status.urls.find(u => u.includes('localhost')) ?? status.urls[0]!
    const ok = await openBrowser(url)
    setFlash({
      text: ok ? `已開啟 ${url}` : `開瀏覽器失敗（複製：${url}）`,
      tone: ok ? 'info' : 'error',
    })
  }

  useInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'q') {
      onExit(status.running ? `web running on :${status.port}` : 'web stopped')
      return
    }
    if (input === 's') void doStart()
    else if (input === 'x') void doStop()
    else if (input === 'r') void refresh()
    else if (input === 'o') void doOpen()
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        /web — Web UI 控制（M-WEB Phase 1）
      </Text>
      <Box marginTop={1} flexDirection="column">
        {error ? (
          <Text color="red">⚠ {error}</Text>
        ) : (
          <>
            <Text>
              狀態：{' '}
              {status.running ? (
                <Text color="green">✓ running</Text>
              ) : (
                <Text color="gray">✗ stopped</Text>
              )}
            </Text>
            {status.running && (
              <>
                <Text>port:              {status.port}</Text>
                <Text>bindHost:          {status.bindHost}</Text>
                <Text>connectedClients:  {status.connectedClients ?? 0}</Text>
                {status.inDevProxyMode && <Text dimColor>（dev proxy mode）</Text>}
              </>
            )}
            {status.lastError && (
              <Text color="red">last error: {status.lastError}</Text>
            )}
          </>
        )}
      </Box>
      {status.running && status.urls && status.urls.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Accessible URLs：</Text>
          {status.urls.map(u => (
            <Text key={u}>  {u}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">
          [s] start  [x] stop  [r] refresh  [o] open browser  [q/esc] 離開
        </Text>
      </Box>
      {busy && (
        <Box marginTop={1}>
          <Text color="yellow">… {busy} …</Text>
        </Box>
      )}
      {flash && (
        <Box marginTop={1}>
          <Text color={flash.tone === 'error' ? 'red' : 'green'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}
