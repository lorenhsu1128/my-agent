/**
 * M-DISCORD-AUTOBIND：bindingHealthCheck 測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { verifyBindings } from '../../../src/discord/bindingHealthCheck'
import { _resetDiscordConfigForTests } from '../../../src/discordConfig/index'

const CONFIG_PATH_KEY = 'DISCORD_CONFIG_PATH'

let tmpDir: string
let origCfgPath: string | undefined

function makeClient(opts: {
  guildFails?: boolean
  existingChannels?: Set<string>
  archiveFn?: () => Promise<void>
}): any {
  return {
    guilds: {
      cache: { get: () => null },
      fetch: async (gid: string) => {
        if (opts.guildFails) throw new Error('unknown guild')
        return {
          channels: {
            fetch: async (chId: string) => {
              if (opts.existingChannels && opts.existingChannels.has(chId)) {
                return {
                  type: 0,
                  name: `ch-${chId}`,
                  setName: async () => undefined,
                  setParent: async () => {
                    if (opts.archiveFn) await opts.archiveFn()
                  },
                }
              }
              return null
            },
          },
        }
      },
    },
  }
}

beforeEach(() => {
  origCfgPath = process.env[CONFIG_PATH_KEY]
  tmpDir = mkdtempSync(join(tmpdir(), 'disc-health-'))
  process.env[CONFIG_PATH_KEY] = join(tmpDir, 'discord.json')
  _resetDiscordConfigForTests()
})
afterEach(() => {
  if (origCfgPath === undefined) delete process.env[CONFIG_PATH_KEY]
  else process.env[CONFIG_PATH_KEY] = origCfgPath
  rmSync(tmpDir, { recursive: true, force: true })
  _resetDiscordConfigForTests()
})

describe('verifyBindings', () => {
  test('guildId missing → skip check, healthy=count', async () => {
    const cfg: any = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: { A: '/any', B: '/any2' },
      streamStrategy: 'turn-end',
      replyMode: 'first',
    }
    const r = await verifyBindings(makeClient({}), cfg)
    expect(r.guildAccessible).toBe(true)
    expect(r.healthy).toBe(2)
    expect(r.staleChannels).toEqual([])
  })

  test('guild unreachable → guildAccessible=false', async () => {
    const cfg: any = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: 'G1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    }
    const r = await verifyBindings(makeClient({ guildFails: true }), cfg)
    expect(r.guildAccessible).toBe(false)
  })

  test('classifies: alive, stale channel (deleted), stale cwd (dir gone)', async () => {
    const liveCwd = join(tmpDir, 'live-project')
    mkdirSync(liveCwd, { recursive: true })
    const goneCwd = join(tmpDir, 'gone-project')
    // 不建立 goneCwd
    writeFileSync(
      join(tmpDir, 'discord.json'),
      JSON.stringify({
        enabled: true,
        whitelistUserIds: [],
        projects: [],
        channelBindings: {
          CH_ALIVE: liveCwd,
          CH_DELETED: goneCwd, // channel 也不存在
          CH_STALECWD: goneCwd, // channel 存在但 cwd 沒
        },
        guildId: 'G1',
      }),
    )
    const cfg: any = {
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {
        CH_ALIVE: liveCwd,
        CH_DELETED: goneCwd,
        CH_STALECWD: goneCwd,
      },
      guildId: 'G1',
      streamStrategy: 'turn-end',
      replyMode: 'first',
    }
    const r = await verifyBindings(
      makeClient({ existingChannels: new Set(['CH_ALIVE', 'CH_STALECWD']) }),
      cfg,
    )
    expect(r.guildAccessible).toBe(true)
    expect(r.healthy).toBe(1)
    expect(r.staleChannels).toEqual(['CH_DELETED'])
    expect(r.staleCwds.length).toBe(1)
    expect(r.staleCwds[0]!.channelId).toBe('CH_STALECWD')
  })
})
