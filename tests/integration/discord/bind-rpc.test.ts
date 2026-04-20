/**
 * M-DISCORD-AUTOBIND：bind/unbind RPC handler 測試（不碰真的 Discord Client）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  handleBindRequest,
  handleUnbindRequest,
  isDiscordBindRequest,
  isDiscordUnbindRequest,
} from '../../../src/daemon/discordBindRpc'
import { _resetDiscordConfigForTests } from '../../../src/discordConfig/index'

const CONFIG_PATH_KEY = 'DISCORD_CONFIG_PATH'

let tmpDir: string
let origCfgPath: string | undefined

/** Mock Discord Client — 只暴露 RPC 會呼到的表面。 */
function makeMockClient(opts?: {
  guildsFetchFails?: boolean
  createdChannelId?: string
  createdChannelName?: string
}): any {
  const createdId = opts?.createdChannelId ?? 'NEW_CHANNEL_ID'
  const createdName = opts?.createdChannelName ?? 'my-agent-abc123'
  const guild = {
    channels: {
      create: async (params: { name: string; topic: string }) => ({
        id: createdId,
        name: params.name,
      }),
      fetch: async () => null,
    },
  }
  return {
    guilds: {
      cache: { get: () => null },
      fetch: async () => {
        if (opts?.guildsFetchFails) throw new Error('guild not found')
        return guild
      },
    },
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => undefined,
      }),
      cache: { get: () => ({ name: 'my-agent-abc123' }) },
    },
  }
}

function writeCfg(cfg: Record<string, unknown>): void {
  writeFileSync(
    join(tmpDir, 'discord.json'),
    JSON.stringify(cfg, null, 2),
    'utf-8',
  )
}

function readCfg(): any {
  return JSON.parse(readFileSync(join(tmpDir, 'discord.json'), 'utf-8'))
}

beforeEach(() => {
  origCfgPath = process.env[CONFIG_PATH_KEY]
  tmpDir = mkdtempSync(join(tmpdir(), 'disc-bind-rpc-'))
  process.env[CONFIG_PATH_KEY] = join(tmpDir, 'discord.json')
  _resetDiscordConfigForTests()
})
afterEach(() => {
  if (origCfgPath === undefined) delete process.env[CONFIG_PATH_KEY]
  else process.env[CONFIG_PATH_KEY] = origCfgPath
  rmSync(tmpDir, { recursive: true, force: true })
  _resetDiscordConfigForTests()
})

describe('frame predicates', () => {
  test('isDiscordBindRequest', () => {
    expect(isDiscordBindRequest({ type: 'discord.bind', requestId: '1', cwd: '/x' })).toBe(true)
    expect(isDiscordBindRequest({ type: 'other' })).toBe(false)
    expect(isDiscordBindRequest(null)).toBe(false)
  })
  test('isDiscordUnbindRequest', () => {
    expect(isDiscordUnbindRequest({ type: 'discord.unbind', requestId: '1', cwd: '/x' })).toBe(true)
    expect(isDiscordUnbindRequest({})).toBe(false)
  })
})

describe('handleBindRequest', () => {
  test('fails when client missing', async () => {
    writeCfg({ enabled: true, whitelistUserIds: [], projects: [], channelBindings: {} })
    const res = await handleBindRequest(
      { type: 'discord.bind', requestId: 'r1', cwd: '/proj' },
      { getClient: () => null, getConfig: () => ({ enabled: true, whitelistUserIds: [], projects: [], channelBindings: {}, streamStrategy: 'turn-end', replyMode: 'first' }) as any },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('gateway not running')
  })

  test('fails when guildId missing', async () => {
    writeCfg({ enabled: true, whitelistUserIds: [], projects: [], channelBindings: {} })
    const res = await handleBindRequest(
      { type: 'discord.bind', requestId: 'r1', cwd: '/proj' },
      { getClient: () => makeMockClient(), getConfig: () => ({ enabled: true, whitelistUserIds: [], projects: [], channelBindings: {}, streamStrategy: 'turn-end', replyMode: 'first' }) as any },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('guildId not set')
  })

  test('creates channel + writes binding + returns url', async () => {
    writeCfg({
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: 'GUILD1',
    })
    const cfg = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: 'GUILD1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    } as any
    const res = await handleBindRequest(
      { type: 'discord.bind', requestId: 'r1', cwd: '/proj/my-agent' },
      { getClient: () => makeMockClient(), getConfig: () => cfg },
    )
    expect(res.ok).toBe(true)
    expect(res.channelId).toBe('NEW_CHANNEL_ID')
    expect(res.url).toContain('GUILD1')
    expect(res.url).toContain('NEW_CHANNEL_ID')
    const persisted = readCfg()
    expect(persisted.channelBindings['NEW_CHANNEL_ID']).toBe('/proj/my-agent')
  })

  test('already-bound cwd returns alreadyBound=true without creating new channel', async () => {
    writeCfg({
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: { EXIST_CH: '/proj/my-agent' },
      guildId: 'GUILD1',
    })
    const cfg = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: { EXIST_CH: '/proj/my-agent' },
      guildId: 'GUILD1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    } as any
    const res = await handleBindRequest(
      { type: 'discord.bind', requestId: 'r1', cwd: '/proj/my-agent' },
      { getClient: () => makeMockClient(), getConfig: () => cfg },
    )
    expect(res.ok).toBe(true)
    expect(res.alreadyBound).toBe(true)
    expect(res.channelId).toBe('EXIST_CH')
  })
})

describe('handleUnbindRequest', () => {
  test('fails when no binding for cwd', async () => {
    writeCfg({
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: 'GUILD1',
    })
    const cfg = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: 'GUILD1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    } as any
    const res = await handleUnbindRequest(
      { type: 'discord.unbind', requestId: 'r1', cwd: '/proj/x' },
      { getClient: () => makeMockClient(), getConfig: () => cfg },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no binding')
  })

  test('renames channel + removes binding from file', async () => {
    writeCfg({
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: { CH1: '/proj/x' },
      guildId: 'GUILD1',
    })
    const cfg = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: { CH1: '/proj/x' },
      guildId: 'GUILD1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    } as any
    const mock: any = makeMockClient()
    // Patch guild.channels.fetch to return a text channel for rename
    mock.guilds.fetch = async () => ({
      channels: {
        fetch: async () => ({
          type: 0, // GuildText = 0
          name: 'my-agent-abc123',
          setName: async () => undefined,
        }),
      },
    })
    const res = await handleUnbindRequest(
      { type: 'discord.unbind', requestId: 'r1', cwd: '/proj/x' },
      { getClient: () => mock, getConfig: () => cfg },
    )
    expect(res.ok).toBe(true)
    const persisted = readCfg()
    expect(persisted.channelBindings.CH1).toBeUndefined()
  })
})
