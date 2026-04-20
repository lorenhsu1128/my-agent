/**
 * M-DISCORD-4：slash command 定義 + permission router 追蹤 hook 測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  ALL_PERMISSION_MODES,
  buildSlashCommands,
} from '../../../src/discord/slashCommands'

describe('buildSlashCommands', () => {
  test('returns 8 commands with expected names', () => {
    const cmds = buildSlashCommands()
    const names = cmds.map(c => c.name).sort()
    expect(names).toEqual(
      [
        'allow',
        'clear',
        'deny',
        'help',
        'interrupt',
        'list',
        'mode',
        'status',
      ].sort(),
    )
  })

  test('/mode command has required string option with 4 choices', () => {
    const cmds = buildSlashCommands()
    const modeCmd = cmds.find(c => c.name === 'mode')!
    expect(modeCmd).toBeDefined()
    const opts = (modeCmd as unknown as { options?: unknown[] }).options
    expect(Array.isArray(opts)).toBe(true)
    const modeOpt = (opts as Array<{ name: string; required?: boolean; choices?: unknown[] }>)[0]
    expect(modeOpt.name).toBe('mode')
    expect(modeOpt.required).toBe(true)
    expect(modeOpt.choices?.length).toBe(4)
  })

  test('/deny has optional reason option', () => {
    const cmds = buildSlashCommands()
    const denyCmd = cmds.find(c => c.name === 'deny')!
    const opts = (denyCmd as unknown as { options?: unknown[] }).options ?? []
    const reasonOpt = (opts as Array<{ name: string; required?: boolean }>)[0]
    expect(reasonOpt?.name).toBe('reason')
    expect(reasonOpt?.required).toBeFalsy()
  })

  test('all commands have DM permission enabled', () => {
    const cmds = buildSlashCommands()
    for (const c of cmds) {
      // dm_permission === true (undefined also means enabled in discord API, but builder sets it explicitly)
      const rec = c as unknown as { dm_permission?: boolean }
      expect(rec.dm_permission !== false).toBe(true)
    }
  })
})

describe('ALL_PERMISSION_MODES', () => {
  test('covers all 4 modes', () => {
    expect(ALL_PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
  })
})
