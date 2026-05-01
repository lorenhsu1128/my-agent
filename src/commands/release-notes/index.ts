import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: '檢視 release notes',
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./release-notes.js'),
}

export default releaseNotes
