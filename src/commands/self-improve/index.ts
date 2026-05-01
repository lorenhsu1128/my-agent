import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'self-improve',
  description: '管理 self-improve nudge 開關與觸發閾值',
  argumentHint: '',
  immediate: true,
  load: () => import('./self-improve.js'),
} satisfies Command
