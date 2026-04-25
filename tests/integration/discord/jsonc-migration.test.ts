/**
 * discord.json JSONC template + migration + 寫回保留註解測試。
 */
import { describe, expect, test } from 'bun:test'
import { parseJsonc } from '../../../src/utils/jsoncStore'
import { DISCORD_JSONC_TEMPLATE } from '../../../src/discordConfig/bundledTemplate'
import { DiscordConfigSchema } from '../../../src/discordConfig/schema'

describe('discord JSONC template', () => {
  test('模板本身是合法 JSONC', () => {
    const parsed = parseJsonc(DISCORD_JSONC_TEMPLATE)
    expect(parsed).toBeDefined()
    expect(parsed).toHaveProperty('enabled')
    expect(parsed).toHaveProperty('whitelistUserIds')
    expect(parsed).toHaveProperty('projects')
  })

  test('模板通過 Zod schema 驗證', () => {
    const parsed = parseJsonc(DISCORD_JSONC_TEMPLATE)
    const result = DiscordConfigSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })

  test('模板預設 enabled=false', () => {
    const parsed = parseJsonc(DISCORD_JSONC_TEMPLATE) as Record<string, unknown>
    expect(parsed.enabled).toBe(false)
  })

  test('模板含繁中註解', () => {
    expect(DISCORD_JSONC_TEMPLATE).toMatch(/\/\/\s+/)
    expect(DISCORD_JSONC_TEMPLATE).toContain('Gateway')
    expect(DISCORD_JSONC_TEMPLATE).toContain('白名單')
    expect(DISCORD_JSONC_TEMPLATE).toContain('whitelistUserIds')
  })

  test('模板註解含安全提醒 + reset token 指引', () => {
    expect(DISCORD_JSONC_TEMPLATE).toContain('0600')
    expect(DISCORD_JSONC_TEMPLATE).toContain('Reset Token')
  })

  test('模板 streamStrategy / replyMode 有合法預設值', () => {
    const parsed = parseJsonc(DISCORD_JSONC_TEMPLATE) as Record<string, unknown>
    expect(['turn-end', 'edit']).toContain(parsed.streamStrategy)
    expect(['first', 'all', 'off']).toContain(parsed.replyMode)
  })
})
