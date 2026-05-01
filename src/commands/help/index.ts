import type { Command } from '../../commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: '顯示說明與可用指令',
  load: () => import('./help.js'),
} satisfies Command

export default help
