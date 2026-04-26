// M-MEMTUI-1-4：`/memory` 入口從 Dialog + MemoryFileSelector 改寫成
// MemoryManager（5-tab master-detail TUI）。舊 spawn $EDITOR 流程在
// Phase 2 由 MemoryManager 內 Shift+E 鍵接管。
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { MemoryManager } from './MemoryManager.js'

function MemoryCommand({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  return (
    <MemoryManager
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <MemoryCommand onDone={onDone} />
}
