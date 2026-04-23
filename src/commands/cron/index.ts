import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'cron',
  description:
    'Interactive cron task manager — list / create / edit / run / pause / delete / view history',
  load: () => import('./cron.js'),
} satisfies Command
