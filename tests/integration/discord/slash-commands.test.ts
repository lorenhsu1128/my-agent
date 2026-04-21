/**
 * M-DISCORD-4：slash command 定義測試。
 * 統一到 `/discord <subcommand>` 命名空間後，結構是單一 top-level command
 * 帶 N 個 subcommand options。
 */
import { describe, expect, test } from 'bun:test'
import {
  ALL_PERMISSION_MODES,
  buildSlashCommands,
} from '../../../src/discord/slashCommands'

type SubcommandJson = {
  name: string
  type?: number
  options?: Array<{ name: string; required?: boolean; choices?: unknown[] }>
}

const SUBCOMMAND_TYPE = 1 // discord.js ApplicationCommandOptionType.Subcommand

describe('buildSlashCommands', () => {
  test('returns single /discord top-level command', () => {
    const cmds = buildSlashCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0]!.name).toBe('discord')
  })

  test('/discord has expected 14 subcommands', () => {
    const cmds = buildSlashCommands()
    const subs =
      (cmds[0] as unknown as { options?: SubcommandJson[] }).options ?? []
    const subNames = subs
      .filter(o => o.type === SUBCOMMAND_TYPE)
      .map(o => o.name)
      .sort()
    expect(subNames).toEqual(
      [
        'allow',
        'bind',
        'clear',
        'deny',
        'guilds',
        'help',
        'interrupt',
        'invite',
        'list',
        'mode',
        'status',
        'unbind',
        'whitelist-add',
        'whitelist-remove',
      ].sort(),
    )
  })

  test('/discord mode has required string option with 4 choices', () => {
    const cmds = buildSlashCommands()
    const subs =
      (cmds[0] as unknown as { options?: SubcommandJson[] }).options ?? []
    const mode = subs.find(o => o.name === 'mode')!
    expect(mode).toBeDefined()
    const modeOpt = (mode.options ?? [])[0]
    expect(modeOpt?.name).toBe('mode')
    expect(modeOpt?.required).toBe(true)
    expect(modeOpt?.choices?.length).toBe(4)
  })

  test('/discord deny has optional reason option', () => {
    const cmds = buildSlashCommands()
    const subs =
      (cmds[0] as unknown as { options?: SubcommandJson[] }).options ?? []
    const deny = subs.find(o => o.name === 'deny')!
    const reasonOpt = (deny.options ?? [])[0]
    expect(reasonOpt?.name).toBe('reason')
    expect(reasonOpt?.required).toBeFalsy()
  })

  test('/discord bind has required project + optional channel', () => {
    const cmds = buildSlashCommands()
    const subs =
      (cmds[0] as unknown as { options?: SubcommandJson[] }).options ?? []
    const bind = subs.find(o => o.name === 'bind')!
    const opts = bind.options ?? []
    const projectOpt = opts.find(o => o.name === 'project')
    const channelOpt = opts.find(o => o.name === 'channel')
    expect(projectOpt?.required).toBe(true)
    expect(channelOpt?.required).toBeFalsy()
  })

  test('/discord whitelist-add requires user option', () => {
    const cmds = buildSlashCommands()
    const subs =
      (cmds[0] as unknown as { options?: SubcommandJson[] }).options ?? []
    const wl = subs.find(o => o.name === 'whitelist-add')!
    const userOpt = (wl.options ?? [])[0]
    expect(userOpt?.name).toBe('user')
    expect(userOpt?.required).toBe(true)
  })

  test('top-level /discord has DM permission enabled', () => {
    const cmds = buildSlashCommands()
    const rec = cmds[0] as unknown as { dm_permission?: boolean }
    expect(rec.dm_permission !== false).toBe(true)
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
