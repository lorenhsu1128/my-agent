import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { TrashPicker } from './TrashPicker.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <TrashPicker
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
