import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'tools',
  description:
    'Enable / disable tools for this REPL (core tools always locked on)',
  load: () => import('./tools.js'),
} satisfies Command
