import type { Command } from '../../commands.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: '管理 tool 權限的 allow / deny 規則',
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
