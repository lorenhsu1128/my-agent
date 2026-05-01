import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: '檢視未 commit 變更與每輪對話 diff',
  load: () => import('./diff.js'),
} satisfies Command
