import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Sign out (not available in this build)',
  isEnabled: () => false, // free-code: 本地模型不需要登出
  load: () => import('./logout.js'),
} satisfies Command
