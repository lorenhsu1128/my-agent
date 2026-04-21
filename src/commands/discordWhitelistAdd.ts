/**
 * REPL slash command `/discord-whitelist-add <userId>`
 *
 * 把 Discord user ID 加進 `~/.my-agent/discord.json` whitelistUserIds。
 * 走 daemon RPC 確保 running gateway 立即看到新白名單（不用重啟）。
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
      value: '用法：`/discord-whitelist-add <userId>`（Discord user ID — 在 Discord 右鍵使用者→「複製 User ID」）',
    }
  }
  if (!/^\d{5,25}$/.test(userId)) {
    return {
      type: 'text',
      value: `❌ 不像 Discord user ID（\`${userId}\`）。應該是純數字 snowflake（17-20 位）。`,
    }
  }
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；`/discord-whitelist-add` 需要 daemon 才能即時生效。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const res = await mgr.discordAdmin({ op: 'whitelistAdd', userId }, 10_000)
  if (res === null) {
    return { type: 'text', value: '逾時（10s）。Discord gateway 可能未啟動。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'whitelistAdd') return { type: 'text', value: '❌ 非預期回應' }
  return {
    type: 'text',
    value: res.changed
      ? `✅ 已把 \`${userId}\` 加進白名單（running gateway 立即生效）`
      : `ℹ️ \`${userId}\` 已在白名單中`,
  }
}

const command = {
  type: 'local',
  name: 'discord-whitelist-add',
  description: '把 Discord user 加進 bot 白名單',
  argumentHint: '<userId>',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
