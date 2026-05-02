// M-MEMRECALL-CMD：`/memory-recall` 命令註冊。觀察與調整 query-driven memory
// prefetch（每輪「Recalled N memories」訊息來源）。詳見 MemoryRecallManager.tsx。

import type { Command } from '../../commands.js'

const memoryRecall: Command = {
  type: 'local-jsx',
  name: 'memory-recall',
  description: '管理 memory recall（每輪 query-driven prefetch）：看 session 命中、改 selector / fallback 上限、edit/delete memory 檔',
  load: () => import('./memory-recall.js'),
}

export default memoryRecall
