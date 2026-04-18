import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasAnthropicApiKeyAuth()
      ? 'Switch accounts (not available in this build)'
      : 'Sign in (not available in this build)',
    isEnabled: () => false, // free-code: 本地模型不需要登入
    load: () => import('./login.js'),
  }) satisfies Command
