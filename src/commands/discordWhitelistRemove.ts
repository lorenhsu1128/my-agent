/**
 * REPL slash command `/discord-whitelist-remove <userId>`
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async (args: string) => {
  const userId = args.trim()
  if (!userId) {
    return {
      type: 'text',
      value: '用法：`/discord-whitelist-remove <userId>`',
    }
  }
  if (!/^\d{5,25}$/.test(userId)) {
    return {
      type: 'text',
      value: `❌ 不像 Discord user ID（\`${userId}\`）。`,
    }
  }
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；`/discord-whitelist-remove` 需要 daemon 才能即時生效。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const res = await mgr.discordAdmin({ op: 'whitelistRemove', userId }, 10_000)
  if (res === null) {
    return { type: 'text', value: '逾時（10s）。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'whitelistRemove') return { type: 'text', value: '❌ 非預期回應' }
  return {
    type: 'text',
    value: res.changed
      ? `✅ 已把 \`${userId}\` 從白名單移除`
      : `ℹ️ \`${userId}\` 本來就不在白名單`,
  }
}

const command = {
  type: 'local',
  name: 'discord-whitelist-remove',
  description: '把 Discord user 從 bot 白名單移除',
  argumentHint: '<userId>',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
