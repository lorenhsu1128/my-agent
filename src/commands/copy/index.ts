/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    '複製 Claude 最近一則回覆到剪貼簿（或 /copy N 複製倒數第 N 則）',
  load: () => import('./copy.js'),
} satisfies Command

export default copy
