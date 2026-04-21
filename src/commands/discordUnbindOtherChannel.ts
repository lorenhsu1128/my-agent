/**
 * REPL slash command `/discord-unbind-other-channel <channelId>`
 *
 * 純 config 層級解綁；不呼叫 Discord API 也不 rename channel。適用任意 guild
 * 的 channel（含對方 guild — bot 沒 Manage Channels 權限時也能解）。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async (args: string) => {
  const channelId = args.trim()
  if (!channelId) {
    return {
      type: 'text',
      value: '用法：`/discord-unbind-other-channel <channelId>`',
    }
  }
  if (!/^\d{5,25}$/.test(channelId)) {
    return {
      type: 'text',
      value: `❌ 不像 Discord channel ID（\`${channelId}\`）`,
    }
  }
  if (!isDaemonAliveSync()) {
    return { type: 'text', value: 'daemon 未啟動；需要 daemon 才能即時生效。' }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const res = await mgr.discordAdmin({ op: 'unbindChannel', channelId }, 10_000)
  if (res === null) {
    return { type: 'text', value: '逾時（10s）。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'unbindChannel') return { type: 'text', value: '❌ 非預期回應' }
  if (!res.changed) {
    return { type: 'text', value: `ℹ️ channel \`${channelId}\` 本來就沒綁` }
  }
  return {
    type: 'text',
    value:
      `✅ 已解除 channel \`${channelId}\` 的 binding（原綁到 \`${res.previousPath}\`）\n` +
      `   Discord 那邊的 channel 本身不變。`,
  }
}

const command = {
  type: 'local',
  name: 'discord-unbind-other-channel',
  description: '以 channel ID 解綁任意 channel（純 config，不動 Discord 端）',
  argumentHint: '<channelId>',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
