/**
 * M-WEB-SLASH-FULL Phase A2 — slashCommandRpc handler 單元測試
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { Command } from '../../../src/types/command'
import type { ContentBlockParam } from 'my-agent-ai/sdk/resources/index'

// 把 commands.getCommands 換成 fake 清單，避免 daemon 全 registry 載入耗時
const fakeCommands: Command[] = [
  {
    name: 'init',
    description: 'init project',
    type: 'prompt',
    progressMessage: '',
    contentLength: 0,
    source: 'builtin',
    getPromptForCommand: async () => [
      { type: 'text', text: 'do init now' },
    ],
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
  test('prompt 命令無 broker 時回 ok=false', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r3',
      name: 'init',
      args: '',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('broker')
  })

  test('prompt 命令有 broker 時 submit 並回 prompt-injected + inputId', async () => {
    const submitted: Array<{ payload: unknown; opts: unknown }> = []
    const fakeBroker = {
      queue: {
        submit: (payload: unknown, opts: unknown) => {
          submitted.push({ payload, opts })
          return 'fake-input-id-1'
        },
      },
    } as unknown as Parameters<typeof handleSlashCommandExecute>[2]['broker']
    const res = await handleSlashCommandExecute(
      '/cwd',
      {
        type: 'slashCommand.execute',
        requestId: 'r3b',
        name: 'init',
        args: '',
      },
      { broker: fakeBroker, clientId: 'c1', source: 'web' },
    )
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('prompt-injected')
    if (res.result?.kind === 'prompt-injected') {
      expect(res.result.inputId).toBe('fake-input-id-1')
    }
    expect(submitted.length).toBe(1)
    expect(typeof submitted[0].payload).toBe('string')
    expect((submitted[0].payload as string).length).toBeGreaterThan(0)
  })

  test('flattenContentBlocksToText 攤平 text + 描述非 text', async () => {
    const { flattenContentBlocksToText } = await import(
      '../../../src/daemon/slashCommandRpc'
    )
    expect(
      flattenContentBlocksToText([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('hello\nworld')
    expect(
      flattenContentBlocksToText([
        { type: 'text', text: 'before' },
        { type: 'image' } as unknown as ContentBlockParam,
        { type: 'text', text: 'after' },
      ]),
    ).toContain('[image]')
  })

  test('local 命令真執行 cmd.load().call() 回 text', async () => {
    const res = await handleSlashCommandExecute('/cwd', {
      type: 'slashCommand.execute',
      requestId: 'r4',
      name: 'help',
      args: 'foo',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.kind).toBe('text')
    if (res.result?.kind === 'text') {
      // fake "help" command returns 'h'
      expect(res.result.value).toBe('h')
    }
  })

  test('local 命令 throw 時回 ok=false', async () => {
    const broken: Command = {
      name: 'broken',
      description: 'broken',
      type: 'local',
      supportsNonInteractive: true,
      load: async () => ({
        call: async () => {
          throw new Error('boom')
        },
      }),
    } as Command
    fakeCommands.push(broken)
    try {
      const res = await handleSlashCommandExecute('/cwd', {
        type: 'slashCommand.execute',
        requestId: 'r4b',
        name: 'broken',
        args: '',
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('boom')
    } finally {
      fakeCommands.pop()
    }
  })

  test('local skip type 回 kind=skip', async () => {
    const skipper: Command = {
      name: 'skipper',
      description: 'skip',
      type: 'local',
      supportsNonInteractive: true,
      load: async () => ({ call: async () => ({ type: 'skip' }) }),
    } as Command
    fakeCommands.push(skipper)
    try {
      const res = await handleSlashCommandExecute('/cwd', {
        type: 'slashCommand.execute',
        requestId: 'r4c',
        name: 'skipper',
        args: '',
      })
      expect(res.ok).toBe(true)
      expect(res.result?.kind).toBe('skip')
    } finally {
      fakeCommands.pop()
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
