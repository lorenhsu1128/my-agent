import type { Command } from '../../commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: '檢視 tool 事件的 hook 設定',
  immediate: true,
  load: () => import('./hooks.js'),
} satisfies Command

export default hooks
