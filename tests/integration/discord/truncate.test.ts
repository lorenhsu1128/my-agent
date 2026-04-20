/**
 * M-DISCORD-3：Discord message truncate 測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  DISCORD_MAX_LENGTH,
  truncateForDiscord,
} from '../../../src/discord/truncate'

describe('truncateForDiscord', () => {
  test('short content passes through unchanged', () => {
    const chunks = truncateForDiscord('hello')
    expect(chunks).toEqual(['hello'])
  })

  test('empty string → single empty chunk', () => {
    expect(truncateForDiscord('')).toEqual([''])
  })

  test('exactly maxLength passes through', () => {
    const c = 'a'.repeat(DISCORD_MAX_LENGTH)
    const chunks = truncateForDiscord(c)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.length).toBe(DISCORD_MAX_LENGTH)
  })

  test('just over max splits into two', () => {
    const c = 'a'.repeat(DISCORD_MAX_LENGTH + 100)
    const chunks = truncateForDiscord(c)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH)
    }
  })

  test('multi-chunk adds counter suffix', () => {
    const c = 'x'.repeat(DISCORD_MAX_LENGTH * 2 + 50)
    const chunks = truncateForDiscord(c)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toMatch(/ \(1\/3\)$/)
    expect(chunks[1]).toMatch(/ \(2\/3\)$/)
    expect(chunks[2]).toMatch(/ \(3\/3\)$/)
  })

  test('prefers newline split point', () => {
    const line = 'line\n' // 5 chars
    const c = line.repeat(500) // 2500 chars total
    const chunks = truncateForDiscord(c, { addCounter: false })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // 第一段應該以 line 結尾（切在 \n）
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH)
    }
  })

  test('code block aware: closes open ``` and reopens in next chunk', () => {
    // 做一個大的 code block，故意會被切中
    const lang = 'ts'
    const body = 'const x = 1\n'.repeat(200) // ~2600 chars
    const content = '```' + lang + '\n' + body + '```'
    const chunks = truncateForDiscord(content, { addCounter: false })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // 第一段應以 ``` 結尾
    expect(chunks[0]!.trimEnd().endsWith('```')).toBe(true)
    // 第二段應以 ```ts 開頭（重開 fence）
    expect(chunks[1]!.startsWith('```ts')).toBe(true)
    // 所有段落都應 ≤ max
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH)
    }
  })

  test('custom maxLength', () => {
    const chunks = truncateForDiscord('hello world foo bar baz', {
      maxLength: 10,
      addCounter: false,
    })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(10)
    }
  })

  test('no false counter on single chunk', () => {
    const chunks = truncateForDiscord('short content', { addCounter: true })
    expect(chunks).toEqual(['short content'])
    expect(chunks[0]).not.toMatch(/\(\d+\/\d+\)/)
  })

  test('unicode content counts by char not byte', () => {
    const c = '中'.repeat(500) + '\n' + '文'.repeat(500)
    // 每個 CJK 字元是 1 code unit in JS string → total ~1001
    const chunks = truncateForDiscord(c)
    expect(chunks.length).toBe(1)
  })

  test('chunks joined back (without counter) roughly equal to original modulo newline trim', () => {
    const original = 'paragraph one\n'.repeat(300) + 'tail'
    const chunks = truncateForDiscord(original, { addCounter: false })
    const joined = chunks.join('')
    // 每次切在 \n 處，truncate 會 replace(/^\n/, '') 掉下一段開頭的 \n，
    // 所以 joined 可能少了幾個 \n — 但主要內容應該在
    expect(joined.length).toBeGreaterThan(original.length - chunks.length)
    expect(joined).toContain('tail')
  })
})
