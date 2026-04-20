/**
 * REPL slash command `/discord-unbind`
 *
 * 解除當前 cwd 的 Discord channel binding。頻道改名 `unbound-<original>` 但不刪除；
 * 歷史訊息保留在 Discord。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async () => {
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；`/discord-unbind` 需要 daemon。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }
  const cwd = process.cwd()
  const res = await mgr.discordUnbind(cwd, 10_000)
  if (res === null) {
    return { type: 'text', value: 'discord-unbind 逾時（10s）。' }
  }
  if (!res.ok) {
    return { type: 'text', value: `discord-unbind 失敗：${res.error}` }
  }
  return {
    type: 'text',
    value: '✅ 已解除 Discord 頻道綁定（頻道改名 `unbound-<原名>`、保留歷史訊息）。',
  }
}

const command = {
  type: 'local',
  name: 'discord-unbind',
  description: '解除當前 cwd 的 Discord channel binding（頻道保留改名）',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
