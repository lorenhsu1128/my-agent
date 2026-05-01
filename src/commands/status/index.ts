import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description: '顯示 my-agent 狀態：版本、模型、帳號、API 連線、tool 狀態',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
