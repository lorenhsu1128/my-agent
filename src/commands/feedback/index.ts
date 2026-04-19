import type { Command } from '../../commands.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about my-agent`,
  argumentHint: '[report]',
  // my-agent: 不對外送回饋，整個 /feedback 指令停用
  isEnabled: () => false,
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
