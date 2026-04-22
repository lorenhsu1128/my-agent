import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'session-delete',
  description:
    'Pick historical sessions to soft-delete (move to .trash). REPL only.',
  load: () => import('./sessionDelete.js'),
} satisfies Command
