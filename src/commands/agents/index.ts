import type { Command } from '../../commands.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: '管理 agent 設定',
  load: () => import('./agents.js'),
} satisfies Command

export default agents
