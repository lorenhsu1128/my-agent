import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: '管理 memory（5-tab：auto-memory / USER / project / local-config / daily-log）',
  load: () => import('./memory.js'),
}

export default memory
