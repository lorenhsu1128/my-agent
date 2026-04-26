import type { Command } from '../../commands.js'

const llamacpp: Command = {
  type: 'local-jsx',
  name: 'llamacpp',
  description:
    'llama.cpp 設定 + slot 監控（Watchdog ABC + Slots tab；無參數開 TUI、有參數直套）',
  load: () => import('./llamacpp.js'),
}

export default llamacpp
