import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { CronPicker } from './CronPicker.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <CronPicker
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
