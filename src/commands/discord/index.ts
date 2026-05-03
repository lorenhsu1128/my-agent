import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'discord',
  description:
    'Discord 整合管理 — 4 個 tab：Bindings / Whitelist / Guilds / Invite',
  load: () => import('./discord.js'),
} satisfies Command
