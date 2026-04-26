/**
 * M-WEB-SLASH-FULL Phase A2 — slashCommandRpc handler 單元測試
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { Command } from '../../../src/types/command'

// 把 commands.getCommands 換成 fake 清單，避免 daemon 全 registry 載入耗時
const fakeCommands: Command[] = [
  {
    name: 'init',
    description: 'init project',
    type: 'prompt',
    progressMessage: '',
    contentLength: 0,
    source: 'builtin',
    getPromptForCommand: async () => [],
  } as Command,
  {
    name: 'help',
    description: 'show help',
    type: 'local',
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'text', value: 'h' }) }),
  } as Command,
  {
    name: 'config',
    description: 'configure',
    type: 'local-jsx',
    load: async () => ({ call: async () => null }),
  } as Command,
  {
    name: 'cron',
    description: 'cron picker',
    type: 'local-jsx',
    load: async () => ({ call: async () => null }),
  } as Command,
  {
    name: 'q',
    description: 'quit',
    type: 'local',
    aliases: ['quit'],
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'text', value: 'bye' }) }),
  } as Command,
]

const commandsModule = await import('../../../src/commands.js')
const originalGetCommands = commandsModule.getCommands
mock.module('../../../src/commands.js', () => ({
  ...commandsModule,
  getCommands: async () => fakeCommands,
}))

const {
  handleSlashCommandList,
  handleSlashCommandExecute,
  isSlashCommandListRequest,
  isSlashCommandExecuteRequest,
} = await import('../../../src/daemon/slashCommandRpc')

afterEach(() => {
  // restore between tests by re-mocking with the same fakeCommands
})

describe('frame type guards', () => {
  test('isSlashCommandListRequest', () => {
    expect(
      isSlashCommandListRequest({ type: 'slashCommand.list', requestId: 'r1' }),
    ).toBe(true)
    expect(isSlashCommandListRequest({ type: 'other' })).toBe(false)
    expect(isSlashCommandListRequest(null)).toBe(false)
    expect(
      isSlashCommandListRequest({ type: 'slashCommand.list' }),
    ).toBe(false) // 缺 requestId
  })

  test('isSlashCommandExecuteRequest', () => {
    expect(
      isSlashCommandExecuteRequest({
        type: 'slashCommand.execute',
        requestId: 'r1',
        name: 'help',
        args: '',
      }),
    ).toBe(true)
    expect(
      isSlashCommandExecuteRequest({
        type: 'slashCommand.execute',
        requestId: 'r1',
        // 缺 name
        args: '',
      }),
    ).toBe(false)
  })
})

describe('handleSlashCommandList', () => {
  test('回 ok=true 與全部 commands metadata', async () => {
    const res = await handleSlashCommandList('/some/cwd', {
      type: 'slashCommand.list',
      requestId: 'r1',
    })
    expect(res.ok).toBe(true)
    expect(res.requestId).toBe('r1')
    expect(res.commands).toBeDefined()
    expect(res.commands!.length).toBe(5)
    const names = res.commands!.map(c => c.name)
    expect(names).toContain('init')
    expect(names).toContain('cron')
  })

  test('結果含 webKind 三種', async () => {
    const res = await handleSlashCommandList('/some/cwd', {
      type: 'slashCommand.list',
      requestId: 'r2',
    })
    const byName = Object.fromEntries(
      res.commands!.map(c => [c.name, c.webKind]),
    )
    expect(byName.init).toBe('runnable')
    expect(byName.help).toBe('runnable')
    expect(byName.config).toBe('jsx-handoff')
    expect(byName.cron).toBe('web-redirect')
  })
})

describe('handleSlashCommandExecute', () => {
  test('prompt 命令回 prompt-injected stub', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r3',
      name: 'init',
      args: '',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('prompt-injected')
  })

  test('local 命令回 A2 stub text', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r4',
      name: 'help',
      args: 'foo',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('text')
    if (res.result?.kind === 'text') {
      expect(res.result.value).toContain('/help')
      expect(res.result.value).toContain('foo')
    }
  })

  test('未 redirect 的 local-jsx 回 jsx-handoff', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r5',
      name: 'config',
      args: '',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('jsx-handoff')
    if (res.result?.kind === 'jsx-handoff') {
      expect(res.result.name).toBe('config')
    }
  })

  test('已 redirect 的 local-jsx (cron) 回 web-redirect', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r6',
      name: 'cron',
      args: '',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('web-redirect')
    if (res.result?.kind === 'web-redirect') {
      expect(res.result.tabId).toBe('cron')
    }
  })

  test('用 alias 也找得到 command', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r7',
      name: 'quit', // alias of "q"
      args: '',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('text')
  })

  test('未知命令回 ok=false', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r8',
      name: 'doesnotexist',
      args: '',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown command')
  })
})
