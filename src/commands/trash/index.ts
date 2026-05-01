import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'trash',
  description:
    '管理軟刪除的 session / memory（list / restore / empty / prune），僅限 REPL',
  load: () => import('./trash.js'),
} satisfies Command
