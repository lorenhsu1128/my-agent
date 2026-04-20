/**
 * M-DISCORD-AUTOBIND：channel naming 測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  computeChannelName,
  sanitizeDirname,
  shortHash,
} from '../../../src/discord/channelNaming'

describe('sanitizeDirname', () => {
  test('plain ASCII kebab', () => {
    expect(sanitizeDirname('my-agent')).toBe('my-agent')
  })

  test('spaces → dash', () => {
    expect(sanitizeDirname('my agent project')).toBe('my-agent-project')
  })

  test('underscore / dot → dash', () => {
    expect(sanitizeDirname('my_agent.v2')).toBe('my-agent-v2')
  })

  test('uppercase → lowercase', () => {
    expect(sanitizeDirname('MyAgent')).toBe('myagent')
  })

  test('Chinese → pinyin', () => {
    const r = sanitizeDirname('我的專案')
    // pinyin "wo de zhuan an" → "wo-de-zhuan-an"（具體轉法讓 pinyin-pro 決定）
    expect(r).toMatch(/^[a-z-]+$/)
    expect(r?.length).toBeGreaterThan(0)
  })

  test('mixed Chinese + ASCII', () => {
    const r = sanitizeDirname('專案-v2')
    // pinyin-pro splits each non-Han char too → v-2, but valid kebab
    expect(r).toMatch(/^[a-z0-9-]+$/)
    expect(r).toContain('zhuan')
  })

  test('Japanese → null fallback', () => {
    // 日文假名不是中文漢字 → 不走 pinyin → 被 filter 掉
    expect(sanitizeDirname('プロジェクト')).toBeNull()
  })

  test('pure emoji → null', () => {
    expect(sanitizeDirname('🚀🔥')).toBeNull()
  })

  test('empty → null', () => {
    expect(sanitizeDirname('')).toBeNull()
  })

  test('only dashes / spaces → null', () => {
    expect(sanitizeDirname('---   ')).toBeNull()
  })

  test('path separators', () => {
    expect(sanitizeDirname('foo/bar\\baz')).toBe('foo-bar-baz')
  })
})

describe('shortHash', () => {
  test('uses first 6 [a-z0-9] of projectId', () => {
    expect(shortHash('c--users-loren-projects-my-agent')).toBe('cusers')
  })

  test('strips non-alphanumeric', () => {
    expect(shortHash('---abc-def-ghi')).toBe('abcdef')
  })

  test('pads if too short', () => {
    expect(shortHash('ab')).toBe('ab0000')
  })

  test('lowercases input', () => {
    expect(shortHash('ABC123XYZ')).toBe('abc123')
  })
})

describe('computeChannelName', () => {
  test('ASCII dirname + projectId hash', () => {
    const r = computeChannelName('c--users-loren-projects-my-agent', 'my-agent')
    expect(r).toBe('my-agent-cusers')
  })

  test('Chinese dirname → pinyin + hash', () => {
    const r = computeChannelName('projabc123', '我的專案')
    expect(r).toMatch(/^[a-z0-9-]+-projab$/)
  })

  test('unsupported dirname → proj fallback', () => {
    const r = computeChannelName('projabc123', '🚀')
    expect(r).toBe('proj-projab')
  })

  test('truncates to 100 chars max', () => {
    const longName = 'a'.repeat(200)
    const r = computeChannelName('hash00', longName)
    expect(r.length).toBeLessThanOrEqual(100)
    expect(r).toMatch(/-hash00$/)
  })

  test('Japanese falls back', () => {
    const r = computeChannelName('xyz789abc', 'プロジェクト')
    expect(r).toBe('proj-xyz789')
  })
})
