// M-MEMRECALL-CMD：`/memory-recall` call wrapper。
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { MemoryRecallManager } from './MemoryRecallManager.js'

function MemoryRecallCommand({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  return (
    <MemoryRecallManager
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <MemoryRecallCommand onDone={onDone} />
}
