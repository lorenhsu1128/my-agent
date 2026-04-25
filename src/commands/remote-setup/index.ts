import type { Command } from '../../commands.js'
// policyLimits removed (M-DECOUPLE-2 Phase 1B)
const isPolicyAllowed = (_policy: string): boolean => true

const web = {
  type: 'local-jsx',
  name: 'web-setup',
  description:
    'Setup my-agent on the web (requires connecting your GitHub account)',
  availability: ['claude-ai'],
  isEnabled: () => isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-setup.js'),
} satisfies Command

export default web
