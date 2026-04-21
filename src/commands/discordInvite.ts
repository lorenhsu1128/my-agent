/**
 * REPL slash command `/discord-invite`
 *
 * 產生 bot 的 OAuth invite URL；copy 給對方 admin 邀 bot 進他們的 server。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async () => {
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；`/discord-invite` 需要 daemon 才能取 bot application id。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const res = await mgr.discordAdmin({ op: 'invite' }, 10_000)
  if (res === null) {
    return { type: 'text', value: '逾時（10s）。Discord gateway 可能未啟動。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'invite') return { type: 'text', value: '❌ 非預期回應' }
  return {
    type: 'text',
    value:
      `🔗 Bot invite URL（轉給對方 admin 邀進他們 server）：\n` +
      `${res.inviteUrl}\n\n` +
      `App ID: ${res.appId}\n` +
      `預設權限：ViewChannel + SendMessages + ReadMessageHistory + AttachFiles`,
  }
}

const command = {
  type: 'local',
  name: 'discord-invite',
  description: '產生 bot 的 OAuth invite URL',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
