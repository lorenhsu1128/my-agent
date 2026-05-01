import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'memory-delete',
  description: '挑選 memory 條目軟刪除或編輯（僅限 REPL）',
  load: () => import('./memoryDelete.js'),
} satisfies Command
