import type { Command } from '../../commands.js'

const rewind = {
  description: `將程式碼或對話回溯到先前某個時間點`,
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
