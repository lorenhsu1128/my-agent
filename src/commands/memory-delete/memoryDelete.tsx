import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { MemoryDeletePicker } from './MemoryDeletePicker.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <MemoryDeletePicker
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
