import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'memory-delete',
  description:
    'Pick memory entries to soft-delete or edit. REPL only.',
  load: () => import('./memoryDelete.js'),
} satisfies Command
