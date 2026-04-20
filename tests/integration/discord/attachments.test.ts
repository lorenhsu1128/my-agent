/**
 * M-DISCORD-3b：attachments 下載 + Markdown 圖片抽取測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cacheDiscordAttachment,
  extractImagesFromText,
  isImageAttachment,
} from '../../../src/discord/attachments'

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'disc-att-'))
})
afterEach(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('isImageAttachment', () => {
  test('by contentType prefix', () => {
    expect(isImageAttachment({ contentType: 'image/png', filename: 'x.bin' })).toBe(
      true,
    )
    expect(isImageAttachment({ contentType: 'image/jpeg', filename: 'y' })).toBe(
      true,
    )
    expect(
      isImageAttachment({ contentType: 'application/pdf', filename: 'z.pdf' }),
    ).toBe(false)
  })
  test('by extension fallback', () => {
    expect(isImageAttachment({ filename: 'a.PNG' })).toBe(true)
    expect(isImageAttachment({ filename: 'a.Jpeg' })).toBe(true)
    expect(isImageAttachment({ filename: 'notes.pdf' })).toBe(false)
    expect(isImageAttachment({ filename: 'no-ext' })).toBe(false)
  })
})

describe('cacheDiscordAttachment', () => {
  test('downloads via fetchImpl and writes to cacheDir', async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
      })) as unknown as typeof fetch

    const result = await cacheDiscordAttachment(
      {
        id: 'a1',
        filename: 'pic.png',
        url: 'https://cdn.example/pic.png',
        contentType: 'image/png',
        size: 4,
      },
      { fetchImpl: fakeFetch, cacheDir },
    )
    expect(result.localPath).toContain(cacheDir)
    expect(result.localPath.endsWith('pic.png')).toBe(true)
    expect(existsSync(result.localPath)).toBe(true)
    expect(result.size).toBe(4)
  })

  test('reuses cached file if same URL already downloaded', async () => {
    let fetchCalls = 0
    const fakeFetch = (async () => {
      fetchCalls++
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof fetch
    const att = {
      id: 'a1',
      filename: 'x.png',
      url: 'https://cdn.example/x.png',
      contentType: 'image/png',
      size: 3,
    }
    await cacheDiscordAttachment(att, { fetchImpl: fakeFetch, cacheDir })
    await cacheDiscordAttachment(att, { fetchImpl: fakeFetch, cacheDir })
    expect(fetchCalls).toBe(1)
  })

  test('rejects oversized attachment (by size claim)', async () => {
    const fakeFetch = (async () => new Response('', {
      status: 200,
    })) as unknown as typeof fetch
    await expect(
      cacheDiscordAttachment(
        {
          id: 'big',
          filename: 'huge.png',
          url: 'https://cdn.example/huge.png',
          size: 100_000_000,
        },
        { fetchImpl: fakeFetch, cacheDir, maxBytes: 1_000 },
      ),
    ).rejects.toThrow(/exceeds max/)
  })

  test('rejects downloaded content over maxBytes', async () => {
    const big = new Uint8Array(500)
    const fakeFetch = (async () =>
      new Response(big, { status: 200 })) as unknown as typeof fetch
    await expect(
      cacheDiscordAttachment(
        {
          id: 'big2',
          filename: 'x.png',
          url: 'https://cdn.example/x.png',
          size: 500,
        },
        { fetchImpl: fakeFetch, cacheDir, maxBytes: 100 },
      ),
    ).rejects.toThrow(/exceeds max/)
  })

  test('throws on non-OK HTTP status', async () => {
    const fakeFetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(
      cacheDiscordAttachment(
        {
          id: 'a',
          filename: 'x.png',
          url: 'https://cdn.example/404.png',
          size: 0,
        },
        { fetchImpl: fakeFetch, cacheDir },
      ),
    ).rejects.toThrow(/download failed/)
  })

  test('sanitizes unsafe filenames (keeps alnum + dots + dashes)', async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch
    const result = await cacheDiscordAttachment(
      {
        id: 'a',
        filename: 'my evil.../file.png',
        url: 'https://cdn.example/ugly.png',
        contentType: 'image/png',
        size: 1,
      },
      { fetchImpl: fakeFetch, cacheDir },
    )
    expect(result.localPath).not.toContain('..')
    expect(result.localPath).not.toContain(' ')
  })
})

describe('extractImagesFromText', () => {
  test('absolute path that exists → extracted to paths', () => {
    // 建一個真檔
    const p = join(cacheDir, 'real.png')
    writeFileSync(p, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const text = `Here is a screenshot: ![before](${p}) — done`
    const r = extractImagesFromText(text)
    expect(r.paths).toEqual([p])
    expect(r.cleanedText).not.toContain(`![before](${p})`)
    expect(r.cleanedText).toContain('[image: before]')
  })

  test('http(s) url → extracted to urls', () => {
    const text = 'see ![pic](https://example.com/foo.png) here'
    const r = extractImagesFromText(text)
    expect(r.urls).toEqual(['https://example.com/foo.png'])
    expect(r.cleanedText).toContain('[image: pic]')
    expect(r.cleanedText).not.toContain('https://example.com/foo.png')
  })

  test('nonexistent absolute path → kept as-is (not extracted)', () => {
    const bogus = join(cacheDir, 'does-not-exist.png')
    const text = `![x](${bogus})`
    const r = extractImagesFromText(text)
    expect(r.paths).toEqual([])
    expect(r.cleanedText).toBe(`![x](${bogus})`)
  })

  test('relative path → not extracted', () => {
    const text = '![x](./relative.png)'
    const r = extractImagesFromText(text)
    expect(r.paths).toEqual([])
    expect(r.urls).toEqual([])
    expect(r.cleanedText).toBe('![x](./relative.png)')
  })

  test('multiple images mixed', () => {
    const p = join(cacheDir, 'pic2.png')
    writeFileSync(p, new Uint8Array([1]))
    const text = [
      'Two pictures:',
      `![a](${p})`,
      '![b](https://ex/b.jpg)',
      '![c](./skip.png)',
    ].join('\n')
    const r = extractImagesFromText(text)
    expect(r.paths).toEqual([p])
    expect(r.urls).toEqual(['https://ex/b.jpg'])
    expect(r.cleanedText).toContain('![c](./skip.png)')
  })

  test('text with no images passes through unchanged', () => {
    const text = 'just words here'
    const r = extractImagesFromText(text)
    expect(r.paths).toEqual([])
    expect(r.urls).toEqual([])
    expect(r.cleanedText).toBe('just words here')
  })
})
