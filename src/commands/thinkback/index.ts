import type { Command } from '../../commands.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: 'Your 2025 my-agent Year in Review',
  isEnabled: () => true,
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
