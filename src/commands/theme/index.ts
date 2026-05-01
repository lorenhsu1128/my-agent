import type { Command } from '../../commands.js'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: '變更主題',
  load: () => import('./theme.js'),
} satisfies Command

export default theme
