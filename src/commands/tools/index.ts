import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'tools',
  description: '啟用/停用本 REPL 的 tools（core tools 強制開啟）',
  load: () => import('./tools.js'),
} satisfies Command
