import type { Command } from '../../commands.js'

const files = {
  type: 'local',
  name: 'files',
  description: '列出目前 context 內的所有檔案',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: true,
  load: () => import('./files.js'),
} satisfies Command

export default files
