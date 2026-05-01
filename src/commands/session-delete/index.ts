import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'session-delete',
  description: '挑選歷史 session 軟刪除（移到 .trash），僅限 REPL',
  load: () => import('./sessionDelete.js'),
} satisfies Command
