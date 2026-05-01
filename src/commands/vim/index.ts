import type { Command } from '../../commands.js'

const command = {
  name: 'vim',
  description: '切換 Vim 與 Normal 編輯模式',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./vim.js'),
} satisfies Command

export default command
