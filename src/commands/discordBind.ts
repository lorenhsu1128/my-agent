/**
 * REPL slash command `/discord-bind`
 *
 * 在當前 cwd 對應的 Discord guild 建立 per-project text channel 並寫入 channelBindings。
 * 必須 daemon 已啟動（gateway 在 daemon 內）。非 attached 模式印引導訊息。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async () => {
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value:
        'daemon 未啟動。請先執行 `my-agent daemon start` 或 `/daemon attach`，然後再試一次。\n' +
        '（`/discord-bind` 需要 daemon 才能呼叫 Discord API）',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value:
        `REPL 目前未 attached 到 daemon（mode=${mgr?.state.mode ?? 'unknown'}）。` +
        `執行 \`/daemon attach\` 後再試。`,
    }
  }
  const cwd = process.cwd()
  const res = await mgr.discordBind(cwd, 15_000)
  if (res === null) {
    return {
      type: 'text',
      value: 'discord-bind 逾時（15s）。daemon 可能沒啟動 Discord gateway，檢查 `~/.my-agent/discord.json` `enabled=true` 且 botToken 有效。',
    }
  }
  if (!res.ok) {
    return { type: 'text', value: `discord-bind 失敗：${res.error}` }
  }
  if (res.alreadyBound) {
    return {
      type: 'text',
      value:
        `此專案已綁定頻道。\n` +
        `  channelId: ${res.channelId}\n` +
        (res.url ? `  url:       ${res.url}\n` : '') +
        `若要改綁，先執行 \`/discord-unbind\` 再 \`/discord-bind\`。`,
    }
  }
  return {
    type: 'text',
    value:
      `✅ 已建立 Discord 頻道並綁定本專案。\n` +
      `  channel:   #${res.channelName ?? '(?)'}  (${res.channelId})\n` +
      (res.url ? `  url:       ${res.url}\n` : '') +
      `在該頻道發訊息會觸發本 project 的 turn；回覆會貼回該頻道。`,
  }
}

const command = {
  type: 'local',
  name: 'discord-bind',
  description: '在 Discord guild 建立 per-project channel 並綁定當前 cwd',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
