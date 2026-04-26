/**
 * M-WEB-SLASH-FULL Phase A1 — slashCommandRegistry projection 單元測試
 */
import { describe, expect, test } from 'bun:test'
import type { Command } from '../../../src/types/command'
import {
  WEB_TAB_REDIRECTS,
  projectCommand,
  projectCommands,
  summarizeSnapshot,
  type SlashCommandMetadata,
} from '../../../src/daemon/slashCommandRegistry'

function mkPrompt(overrides: Partial<Command> = {}): Command {
  return {
    name: 'init',
    description: 'init a project',
    type: 'prompt',
    progressMessage: '...',
    contentLength: 100,
    source: 'builtin',
    getPromptForCommand: async () => [],
    ...overrides,
  } as Command
}

function mkLocal(overrides: Partial<Command> = {}): Command {
  return {
    name: 'cost',
    description: 'show cost',
    type: 'local',
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'text', value: '$0' }) }),
    ...overrides,
  } as Command
}

function mkLocalJsx(overrides: Partial<Command> = {}): Command {
  return {
    name: 'config',
    description: 'configure',
    type: 'local-jsx',
    load: async () => ({ call: async () => null }),
    ...overrides,
  } as Command
}

describe('projectCommand', () => {
  test('prompt command 被標記為 runnable', () => {
    const meta = projectCommand(mkPrompt({ name: 'init' }))
    expect(meta.name).toBe('init')
    expect(meta.type).toBe('prompt')
    expect(meta.webKind).toBe('runnable')
    expect(meta.handoffKey).toBeUndefined()
    expect(meta.source).toBe('builtin')
  })

  test('local command 被標記為 runnable', () => {
    const meta = projectCommand(mkLocal({ name: 'cost' }))
    expect(meta.type).toBe('local')
    expect(meta.webKind).toBe('runnable')
    expect(meta.handoffKey).toBeUndefined()
  })

  test('未被 redirect 的 local-jsx 標記為 jsx-handoff，handoffKey=name', () => {
    const meta = projectCommand(mkLocalJsx({ name: 'config' }))
    expect(meta.type).toBe('local-jsx')
    expect(meta.webKind).toBe('jsx-handoff')
    expect(meta.handoffKey).toBe('config')
  })

  test('被 redirect 的 4 個 local-jsx 標記為 web-redirect 並指向對應 tab', () => {
    expect(projectCommand(mkLocalJsx({ name: 'cron' })).webKind).toBe(
      'web-redirect',
    )
    expect(projectCommand(mkLocalJsx({ name: 'cron' })).handoffKey).toBe('cron')

    expect(projectCommand(mkLocalJsx({ name: 'memory' })).handoffKey).toBe(
      'memory',
    )
    expect(projectCommand(mkLocalJsx({ name: 'llamacpp' })).handoffKey).toBe(
      'llamacpp',
    )
    expect(
      projectCommand(mkLocalJsx({ name: 'discord-bind' })).handoffKey,
    ).toBe('discord')
  })

  test('aliases / argumentHint / isHidden / kind 正確透傳', () => {
    const meta = projectCommand(
      mkLocal({
        name: 'help',
        aliases: ['h', '?'],
        argumentHint: '<topic>',
        isHidden: true,
        kind: 'workflow',
      }),
    )
    expect(meta.aliases).toEqual(['h', '?'])
    expect(meta.argumentHint).toBe('<topic>')
    expect(meta.isHidden).toBe(true)
    expect(meta.kind).toBe('workflow')
  })

  test('userFacingName 走 cmd.userFacingName() override', () => {
    const meta = projectCommand(
      mkLocal({
        name: 'plugin:foo:bar',
        userFacingName: () => 'bar',
      }),
    )
    expect(meta.userFacingName).toBe('bar')
    expect(meta.name).toBe('plugin:foo:bar')
  })

  test('沒有 aliases 不會在 metadata 中出現空陣列', () => {
    const meta = projectCommand(mkPrompt({ aliases: undefined }))
    expect(meta.aliases).toBeUndefined()
  })

  test('prompt argNames 透傳', () => {
    const meta = projectCommand(
      mkPrompt({ argNames: ['file', 'lang'] }),
    )
    expect(meta.argNames).toEqual(['file', 'lang'])
  })
})

describe('projectCommands (filter + sort)', () => {
  test('過濾 isCommandEnabled=false 的 command', () => {
    const enabled = mkLocal({ name: 'foo' })
    const disabled = mkLocal({
      name: 'bar',
      isEnabled: () => false,
    })
    const result = projectCommands([enabled, disabled])
    expect(result.map(m => m.name)).toEqual(['foo'])
  })

  test('結果按 userFacingName 字典序排序', () => {
    const result = projectCommands([
      mkLocal({ name: 'zebra' }),
      mkLocal({ name: 'apple' }),
      mkLocal({ name: 'mango' }),
    ])
    expect(result.map(m => m.name)).toEqual(['apple', 'mango', 'zebra'])
  })
})

describe('summarizeSnapshot', () => {
  test('正確統計 webKind 與 type 分布', () => {
    const snapshot: SlashCommandMetadata[] = [
      projectCommand(mkPrompt({ name: 'init' })),
      projectCommand(mkPrompt({ name: 'review' })),
      projectCommand(mkLocal({ name: 'cost' })),
      projectCommand(mkLocal({ name: 'help' })),
      projectCommand(mkLocal({ name: 'clear' })),
      projectCommand(mkLocalJsx({ name: 'config' })),
      projectCommand(mkLocalJsx({ name: 'model' })),
      projectCommand(mkLocalJsx({ name: 'cron' })), // redirect
      projectCommand(mkLocalJsx({ name: 'memory' })), // redirect
    ]
    const s = summarizeSnapshot(snapshot)
    expect(s.total).toBe(9)
    expect(s.runnable).toBe(5) // 2 prompt + 3 local
    expect(s.jsxHandoff).toBe(2) // config + model
    expect(s.webRedirect).toBe(2) // cron + memory
    expect(s.byType.prompt).toBe(2)
    expect(s.byType.local).toBe(3)
    expect(s.byType['local-jsx']).toBe(4)
  })

  test('空陣列回零', () => {
    const s = summarizeSnapshot([])
    expect(s.total).toBe(0)
    expect(s.runnable).toBe(0)
    expect(s.jsxHandoff).toBe(0)
    expect(s.webRedirect).toBe(0)
  })
})

describe('WEB_TAB_REDIRECTS', () => {
  test('含且僅含 4 個預期的 redirect', () => {
    expect(Object.keys(WEB_TAB_REDIRECTS).sort()).toEqual([
      'cron',
      'discord-bind',
      'llamacpp',
      'memory',
    ])
  })

  test('是 frozen 不可變', () => {
    expect(Object.isFrozen(WEB_TAB_REDIRECTS)).toBe(true)
  })
})
