/**
 * REPL slash command `/discord-guilds`
 *
 * 列出 bot 目前所在的所有 Discord guild。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async () => {
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；`/discord-guilds` 需要 daemon 才能讀 Discord client guild cache。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const res = await mgr.discordAdmin({ op: 'guilds' }, 10_000)
  if (res === null) {
    return { type: 'text', value: '逾時（10s）。Discord gateway 可能未啟動。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'guilds') return { type: 'text', value: '❌ 非預期回應' }
  if (res.guilds.length === 0) {
    return {
      type: 'text',
      value: '_(bot 目前不在任何 guild — 用 `/discord-invite` 取邀請連結)_',
    }
  }
  const lines = [`Bot 所在 guild — ${res.guilds.length} 個：`]
  for (const g of res.guilds) {
    lines.push(`• ${g.name}  (${g.id})  members=${g.memberCount}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const command = {
  type: 'local',
  name: 'discord-guilds',
  description: '列出 bot 目前所在的 Discord guild',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
