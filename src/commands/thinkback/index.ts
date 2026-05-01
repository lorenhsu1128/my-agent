import type { Command } from '../../commands.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: '你的 2025 my-agent 年度回顧',
  isEnabled: () => true,
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
