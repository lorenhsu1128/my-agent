/**
 * M-DISCORD-AUTOBIND：schema 向後相容 — 舊 config（無 guildId / archiveCategoryId）
 * 能正常解析；新欄位解析時保留值。
 */
import { describe, expect, test } from 'bun:test'
import { DiscordConfigSchema } from '../../../src/discordConfig/schema'

describe('DiscordConfigSchema backward compatibility', () => {
  test('legacy config without guildId/archiveCategoryId parses fine', () => {
    const legacy = {
      enabled: true,
      botToken: 'abc',
      whitelistUserIds: ['123'],
      projects: [],
      channelBindings: {},
      homeChannelId: '456',
      streamStrategy: 'turn-end' as const,
      replyMode: 'first' as const,
    }
    const r = DiscordConfigSchema.parse(legacy)
    expect(r.guildId).toBeUndefined()
    expect(r.archiveCategoryId).toBeUndefined()
    expect(r.homeChannelId).toBe('456')
  })

  test('config with new fields preserved', () => {
    const r = DiscordConfigSchema.parse({
      enabled: true,
      whitelistUserIds: [],
      projects: [],
      channelBindings: {},
      guildId: '1194148148495532033',
      archiveCategoryId: '1495785196509991033',
    })
    expect(r.guildId).toBe('1194148148495532033')
    expect(r.archiveCategoryId).toBe('1495785196509991033')
  })
})
