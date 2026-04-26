import type { Command } from '../../commands.js'

const web: Command = {
  type: 'local-jsx',
  name: 'web',
  description:
    'Web UI 控制（start/stop/status/open；M-WEB Phase 1）— 需在 daemon 模式運作',
  load: () => import('./web.js'),
}

export default web
