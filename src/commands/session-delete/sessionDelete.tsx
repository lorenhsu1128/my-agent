import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { SessionDeletePicker } from './SessionDeletePicker.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <SessionDeletePicker
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
