import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { ToolsPicker } from './ToolsPicker.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <ToolsPicker
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
