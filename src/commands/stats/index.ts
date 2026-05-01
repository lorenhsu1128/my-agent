import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: '顯示 my-agent 使用統計與活動',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
