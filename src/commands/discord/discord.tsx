import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { DiscordManager } from './DiscordManager.js'

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return (
    <DiscordManager
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}
