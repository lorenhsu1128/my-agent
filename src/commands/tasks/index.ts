import type { Command } from '../../commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],
  description: '列出與管理背景 task',
  load: () => import('./tasks.js'),
} satisfies Command

export default tasks
