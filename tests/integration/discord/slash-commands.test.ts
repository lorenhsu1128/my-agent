/**
 * M-DISCORD-4：slash command 定義測試。
 * Flat 結構 — 14 個 top-level command，每個獨立註冊。
 */
import { describe, expect, test } from 'bun:test'
import {
  ALL_PERMISSION_MODES,
  MY_AGENT_COMMAND_NAMES,
  buildSlashCommands,
} from '../../../src/discord/slashCommands'

type CommandJson = {
  name: string
  dm_permission?: boolean
  options?: Array<{ name: string; required?: boolean; choices?: unknown[] }>
}

const EXPECTED_NAMES = [
  'allow',
  'bind-other-channel',
  'clear',
  'deny',
  'guilds',
  'help',
  'interrupt',
  'invite',
  'list',
  'mode',
  'status',
  'unbind-other-channel',
  'whitelist-add',
  'whitelist-remove',
].sort()

describe('buildSlashCommands', () => {
  test('returns 14 flat top-level commands', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    expect(cmds).toHaveLength(14)
    const names = cmds.map(c => c.name).sort()
    expect(names).toEqual(EXPECTED_NAMES)
  })

  test('MY_AGENT_COMMAND_NAMES covers all registered commands', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    const registered = cmds.map(c => c.name).sort()
    expect([...MY_AGENT_COMMAND_NAMES].sort()).toEqual(registered)
  })

  test('/mode has required string option with 4 choices', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    const mode = cmds.find(c => c.name === 'mode')!
    expect(mode).toBeDefined()
    const modeOpt = (mode.options ?? [])[0]
    expect(modeOpt?.name).toBe('mode')
    expect(modeOpt?.required).toBe(true)
    expect(modeOpt?.choices?.length).toBe(4)
  })

  test('/deny has optional reason option', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    const deny = cmds.find(c => c.name === 'deny')!
    const reasonOpt = (deny.options ?? [])[0]
    expect(reasonOpt?.name).toBe('reason')
    expect(reasonOpt?.required).toBeFalsy()
  })

  test('/bind-other-channel has required project + optional channel', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    const bind = cmds.find(c => c.name === 'bind-other-channel')!
    const opts = bind.options ?? []
    const projectOpt = opts.find(o => o.name === 'project')
    const channelOpt = opts.find(o => o.name === 'channel')
    expect(projectOpt?.required).toBe(true)
    expect(channelOpt?.required).toBeFalsy()
  })

  test('/whitelist-add requires user option', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    const wl = cmds.find(c => c.name === 'whitelist-add')!
    const userOpt = (wl.options ?? [])[0]
    expect(userOpt?.name).toBe('user')
    expect(userOpt?.required).toBe(true)
  })

  test('every command has DM permission enabled', () => {
    const cmds = buildSlashCommands() as unknown as CommandJson[]
    for (const c of cmds) {
      expect(c.dm_permission !== false).toBe(true)
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
