/**
 * REPL slash command `/discord-bind-other-channel <channelId> [projectKey]`
 *
 * 把已存在的 Discord channel（可能在任意 guild）綁到指定 project。與
 * `/discord-bind`（在自家 guild 新建 channel）互補。
 *
 * projectKey 省略時 → auto-register 當前 cwd 為 project（若 projects[] 沒對應
 * entry 就 append 一個 `{ id, name, path, aliases: [] }`）。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'
import { loadDiscordConfigSnapshot } from '../discordConfig/loader.js'

function findProjectByKey(
  projects: ReadonlyArray<{ id: string; name: string; path: string; aliases: string[] }>,
  key: string,
): { id: string; path: string } | null {
  const lower = key.toLowerCase()
  for (const p of projects) {
    if (p.id.toLowerCase() === lower) return p
    if (p.aliases.some(a => a.toLowerCase() === lower)) return p
  }
  return null
}

const call: LocalCommandCall = async (args: string) => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const channelId = tokens[0]
  const projectKey = tokens[1]

  if (!channelId) {
    return {
      type: 'text',
      value:
        '用法：`/discord-bind-other-channel <channelId> [projectKey]`\n' +
        '  省略 projectKey 時會 auto-register 當前 cwd 為 project。',
    }
  }
  if (!/^\d{5,25}$/.test(channelId)) {
    return {
      type: 'text',
      value: `❌ 不像 Discord channel ID（\`${channelId}\`）— 應為 17-20 位純數字 snowflake`,
    }
  }
  if (!isDaemonAliveSync()) {
    return {
      type: 'text',
      value: 'daemon 未啟動；此指令需要 daemon 才能 call Discord API。',
    }
  }
  const mgr = getCurrentDaemonManager()
  if (!mgr || mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）；先 \`/daemon attach\` 再試。`,
    }
  }

  // 決定 projectPath + autoRegister
  let projectPath: string
  let autoRegister = false
  if (projectKey) {
    const cfg = await loadDiscordConfigSnapshot()
    const found = findProjectByKey(cfg.projects, projectKey)
    if (!found) {
      const list = cfg.projects.map(p => `- ${p.id} → ${p.path}`).join('\n') || '(空)'
      return {
        type: 'text',
        value: `❌ 找不到 project \`${projectKey}\`。可用：\n${list}`,
      }
    }
    projectPath = found.path
  } else {
    projectPath = process.cwd()
    autoRegister = true
  }

  const res = await mgr.discordAdmin(
    { op: 'bindChannel', channelId, projectPath, autoRegister },
    15_000,
  )
  if (res === null) {
    return { type: 'text', value: '逾時（15s）。Discord gateway 可能未啟動。' }
  }
  if (!res.ok) return { type: 'text', value: `❌ ${res.error}` }
  if (res.op !== 'bindChannel') return { type: 'text', value: '❌ 非預期回應' }

  const lines = [
    `✅ 已綁定 **#${res.channelName}** (\`${res.channelId}\`) → \`${projectPath}\``,
    `   guild: ${res.guildName} (\`${res.guildId}\`)`,
  ]
  if (res.autoRegistered) {
    lines.push(`ℹ️ 此 cwd 首次使用，已自動 append 到 projects[]`)
  }
  if (res.existingChannels && res.existingChannels.length > 0) {
    lines.push(
      `⚠️ 此 cwd 已有 ${res.existingChannels.length} 個 channel 綁定（${res.existingChannels.join(', ')}）；session 會共享`,
    )
  }
  return { type: 'text', value: lines.join('\n') }
}

const command = {
  type: 'local',
  name: 'discord-bind-other-channel',
  description: '以 channel ID 綁定任意（含跨 guild）channel 到 project',
  argumentHint: '<channelId> [projectKey]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
