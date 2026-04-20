/**
 * M-DISCORD-3：router 單元測試。
 * 覆蓋：whitelist、channel binding、DM prefix、alias、default fallback、
 * 錯誤前綴、空訊息。
 */
import { describe, expect, test } from 'bun:test'
import {
  parseProjectPrefix,
  routeMessage,
  isUserWhitelisted,
} from '../../../src/discord/router'
import {
  DEFAULT_DISCORD_CONFIG,
  type DiscordConfig,
} from '../../../src/discordConfig/schema'

const USER_WHITELIST = '100000000000000001'
const USER_OUTSIDE = '100000000000000002'

const baseConfig = (
  overrides: Partial<DiscordConfig> = {},
): DiscordConfig => ({
  ...DEFAULT_DISCORD_CONFIG,
  enabled: true,
  whitelistUserIds: [USER_WHITELIST],
  projects: [
    { id: 'my-agent', name: 'My Agent', path: '/abs/my-agent', aliases: ['ma', 'agent'] },
    { id: 'blog', name: 'Blog', path: '/abs/blog', aliases: [] },
  ],
  defaultProjectPath: '/abs/my-agent',
  channelBindings: { '555': '/abs/blog' },
  ...overrides,
})

describe('parseProjectPrefix', () => {
  test('matches #projectId with space', () => {
    expect(parseProjectPrefix('#my-agent hello')).toEqual({
      projectKey: 'my-agent',
      stripped: 'hello',
    })
  })
  test('matches with newline after', () => {
    expect(parseProjectPrefix('#blog\nhi')).toEqual({
      projectKey: 'blog',
      stripped: 'hi',
    })
  })
  test('matches alone without body', () => {
    expect(parseProjectPrefix('#blog')).toEqual({
      projectKey: 'blog',
      stripped: '',
    })
  })
  test('leading whitespace tolerated', () => {
    expect(parseProjectPrefix('   #ma hey')).toEqual({
      projectKey: 'ma',
      stripped: 'hey',
    })
  })
  test('no prefix → null', () => {
    expect(parseProjectPrefix('just chatting')).toBeNull()
    expect(parseProjectPrefix('# nope')).toBeNull() // space after # → not match
    expect(parseProjectPrefix('hi #blog inside')).toBeNull()
  })
  test('unicode project id', () => {
    expect(parseProjectPrefix('#中文專案 你好')).toEqual({
      projectKey: '中文專案',
      stripped: '你好',
    })
  })
})

describe('isUserWhitelisted', () => {
  test('returns true for whitelisted user', () => {
    expect(isUserWhitelisted(USER_WHITELIST, baseConfig())).toBe(true)
  })
  test('returns false for non-whitelisted user', () => {
    expect(isUserWhitelisted(USER_OUTSIDE, baseConfig())).toBe(false)
  })
  test('returns false when whitelist empty', () => {
    expect(
      isUserWhitelisted(USER_WHITELIST, baseConfig({ whitelistUserIds: [] })),
    ).toBe(false)
  })
})

describe('routeMessage — whitelist', () => {
  test('rejects non-whitelisted user', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'c1',
        authorId: USER_OUTSIDE,
        content: 'hi',
      },
      baseConfig(),
    )
    expect(r).toEqual({ ok: false, reason: 'whitelist' })
  })
})

describe('routeMessage — guild channel', () => {
  test('bound channel → route to bound project', () => {
    const r = routeMessage(
      {
        channelType: 'guild',
        channelId: '555',
        authorId: USER_WHITELIST,
        content: 'hello from channel',
      },
      baseConfig(),
    )
    expect(r).toEqual({
      ok: true,
      projectPath: '/abs/blog',
      prompt: 'hello from channel',
      via: 'channel-binding',
    })
  })
  test('unbound channel → reject', () => {
    const r = routeMessage(
      {
        channelType: 'guild',
        channelId: '999',
        authorId: USER_WHITELIST,
        content: 'hi',
      },
      baseConfig(),
    )
    expect(r).toEqual({ ok: false, reason: 'no-binding' })
  })
  test('bound channel but empty content → reject', () => {
    const r = routeMessage(
      {
        channelType: 'guild',
        channelId: '555',
        authorId: USER_WHITELIST,
        content: '   \n  ',
      },
      baseConfig(),
    )
    expect(r).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('routeMessage — DM prefix', () => {
  test('#projectId matches id', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: '#my-agent help',
      },
      baseConfig(),
    )
    if (!r.ok) throw new Error('expected ok')
    expect(r.projectPath).toBe('/abs/my-agent')
    expect(r.prompt).toBe('help')
    expect(r.via).toBe('prefix')
    expect(r.matchedId).toBe('my-agent')
  })
  test('#alias matches', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: '#ma hi',
      },
      baseConfig(),
    )
    if (!r.ok) throw new Error('expected ok')
    expect(r.projectPath).toBe('/abs/my-agent')
    expect(r.matchedId).toBe('my-agent')
  })
  test('unknown prefix → reject with hint', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: '#nope hi',
      },
      baseConfig(),
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected not ok')
    expect(r.reason).toBe('prefix-unknown')
    expect(r.hint).toContain('#my-agent')
  })
  test('prefix without body → empty reason', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: '#blog',
      },
      baseConfig(),
    )
    expect(r).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('routeMessage — DM default', () => {
  test('no prefix → defaultProjectPath', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: 'just chatting',
      },
      baseConfig(),
    )
    if (!r.ok) throw new Error('expected ok')
    expect(r.projectPath).toBe('/abs/my-agent')
    expect(r.via).toBe('default')
    expect(r.prompt).toBe('just chatting')
  })
  test('no prefix + no default → reject with hint', () => {
    const r = routeMessage(
      {
        channelType: 'dm',
        channelId: 'dm1',
        authorId: USER_WHITELIST,
        content: 'hi',
      },
      baseConfig({ defaultProjectPath: undefined }),
    )
    if (r.ok) throw new Error('expected not ok')
    expect(r.reason).toBe('no-default')
    expect(r.hint).toContain('defaultProjectPath')
  })
})
