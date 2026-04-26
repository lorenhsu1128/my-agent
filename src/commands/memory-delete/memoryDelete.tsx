// M-MEMTUI Phase 4：/memory-delete 收為 alias，渲染 MemoryManager 並傳
// initialMode='multi-delete' 直接進多選模式（保留 muscle memory）。
//
// 舊 MemoryDeletePicker 已被 MemoryManager 的 multi-delete mode 取代；保留檔
// 不刪是為了避免 git history 找尋者疑惑。
import type { LocalJSXCommandCall } from '../../types/command.js'
import { MemoryManager } from '../memory/MemoryManager.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <MemoryManager
      initialMode="multi-delete"
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
