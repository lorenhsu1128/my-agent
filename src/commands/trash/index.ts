import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'trash',
  description:
    'Manage soft-deleted sessions / memory (list / restore / empty / prune). REPL only.',
  load: () => import('./trash.js'),
} satisfies Command
