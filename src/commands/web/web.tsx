// M-WEB-7：`/web` 入口（hybrid：無參數開 TUI、有參數直接執行）。
// Phase 1 範圍：args mode 已完整；TUI mode 暫時 fallback 到 status 文字。
import * as React from 'react'
import { toString as qrToString } from 'qrcode'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { HELP_TEXT, parseWebArgs } from './argsParser.js'
import { sendWebControlToDaemon } from '../../hooks/useDaemonMode.js'
import { openBrowser } from '../../utils/browser.js'
import type { WebControlStatus } from '../../repl/thinClient/fallbackManager.js'
import { WebManager } from './WebManager.js'

function formatStatus(s: WebControlStatus): string {
  if (!s.running) {
    return [
      `running:           ✗ stopped`,
      s.lastError ? `last error:        ${s.lastError}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }
  const lines = [
    `running:           ✓`,
    `port:              ${s.port}`,
    `bindHost:          ${s.bindHost}`,
    `connectedClients:  ${s.connectedClients ?? 0}`,
  ]
  if (s.inDevProxyMode) lines.push(`mode:              dev proxy`)
  if (s.startedAt) {
    const ms = Date.now() - s.startedAt
    lines.push(`uptime:            ${Math.floor(ms / 1000)}s`)
  }
  if (s.urls && s.urls.length > 0) {
    lines.push('')
    lines.push('Accessible URLs:')
    for (const u of s.urls) lines.push(`  ${u}`)
  }
  return lines.join('\n')
}

async function runArgsCommand(
  args: string,
): Promise<{ display: 'system' | 'condensed'; text: string }> {
  const parsed = parseWebArgs(args)

  if (parsed.kind === 'help') {
    return { display: 'system', text: HELP_TEXT }
  }
  if (parsed.kind === 'error') {
    return { display: 'system', text: `❌ ${parsed.message}\n\n${HELP_TEXT}` }
  }

  if (parsed.kind === 'start' || parsed.kind === 'stop' || parsed.kind === 'status') {
    const op = parsed.kind
    const r = await sendWebControlToDaemon(op, 30_000)
    if (r === null) {
      return {
        display: 'system',
        text: '❌ daemon 未啟動或未 attached。請先 `my-agent daemon start` 並重新進入 REPL。',
      }
    }
    if (!r.ok) {
      return {
        display: 'system',
        text: `❌ ${op} 失敗：${r.error}\n\n${r.status ? formatStatus(r.status) : ''}`,
      }
    }
    const verb =
      op === 'start' ? '✓ web server 啟動' : op === 'stop' ? '✓ web server 停止' : 'web server 狀態'
    return {
      display: 'system',
      text: `${verb}\n\n${formatStatus(r.status)}`,
    }
  }

  if (parsed.kind === 'open') {
    const r = await sendWebControlToDaemon('status', 5_000)
    if (r === null || !r.ok || !r.status.running || !r.status.urls?.length) {
      return {
        display: 'system',
        text: '❌ web server 未啟動；先 `/web start`',
      }
    }
    // 偏好 localhost 而非 0.0.0.0（後者瀏覽器可能不接受）
    const url =
      r.status.urls.find(u => u.includes('localhost')) ?? r.status.urls[0]!
    const ok = await openBrowser(url)
    return {
      display: 'system',
      text: ok ? `✓ 已開啟 ${url}` : `❌ 無法開啟瀏覽器（手動複製：${url}）`,
    }
  }

  if (parsed.kind === 'qr') {
    const r = await sendWebControlToDaemon('status', 5_000)
    if (r === null || !r.ok || !r.status.running || !r.status.urls?.length) {
      return {
        display: 'system',
        text: '❌ web server 未啟動；先 `/web start`',
      }
    }
    const url =
      r.status.urls.find(u => /\d+\.\d+\.\d+\.\d+/.test(u)) ?? r.status.urls[0]!
    const qr = await qrToString(url, { type: 'terminal', small: true })
    return {
      display: 'system',
      text: `掃描連線到：${url}\n\n${qr}`,
    }
  }

  // 不應到此（kind: 'tui' 已被外層攔下）
  return { display: 'system', text: HELP_TEXT }
}

function WebCommand({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  return (
    <WebManager
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const argsStr = (args ?? '').trim()
  if (argsStr === '') {
    return <WebCommand onDone={onDone} />
  }
  const r = await runArgsCommand(argsStr)
  onDone(r.text, { display: r.display })
  return null
}
