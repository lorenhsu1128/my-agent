/**
 * M-DISCORD-3b：messageAdapter 測試（Discord Message → agent prompt + image blocks）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { adaptDiscordMessage } from '../../../src/discord/messageAdapter'
import type { DiscordIncomingMessage } from '../../../src/discord/types'

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'msg-adapt-'))
})
afterEach(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const makeMsg = (
  overrides: Partial<DiscordIncomingMessage> = {},
): DiscordIncomingMessage => ({
  id: 'm1',
  channelId: 'c1',
  channelType: 'dm',
  authorId: 'u1',
  content: 'hi',
  attachments: [],
  receivedAt: Date.now(),
  ...overrides,
})

const okFetch = (data: Uint8Array) =>
  (async () => new Response(data, { status: 200 })) as unknown as typeof fetch

describe('adaptDiscordMessage — no attachments', () => {
  test('plain text → text only, no images', async () => {
    const r = await adaptDiscordMessage(makeMsg(), {
      promptText: 'hello agent',
      visionEnabled: false,
    })
    expect(r.text).toBe('hello agent')
    expect(r.images).toEqual([])
    expect(r.imageBlocks).toEqual([])
    expect(r.otherAttachments).toEqual([])
  })
})

describe('adaptDiscordMessage — image attachments', () => {
  test('vision enabled → images cached + imageBlocks produced, no hint text', async () => {
    const msg = makeMsg({
      attachments: [
        {
          id: 'a1',
          filename: 'pic.png',
          url: 'https://cdn/pic.png',
          contentType: 'image/png',
          size: 4,
        },
      ],
    })
    const r = await adaptDiscordMessage(msg, {
      promptText: 'look at this',
      visionEnabled: true,
      download: { fetchImpl: okFetch(new Uint8Array([1, 2, 3, 4])), cacheDir },
    })
    expect(r.images.length).toBe(1)
    expect(r.imageBlocks.length).toBe(1)
    expect(r.imageBlocks[0]!.source.path).toBe(r.images[0]!.localPath)
    expect(r.imageBlocks[0]!.source.media_type).toBe('image/png')
    expect(r.text).toBe('look at this')
    expect(r.text).not.toContain('[Image attachment')
  })

  test('vision disabled → inline [Image attachment: name] hints, no imageBlocks', async () => {
    const msg = makeMsg({
      attachments: [
        {
          id: 'a1',
          filename: 'photo.jpg',
          url: 'https://cdn/photo.jpg',
          contentType: 'image/jpeg',
          size: 2,
        },
      ],
    })
    const r = await adaptDiscordMessage(msg, {
      promptText: 'check',
      visionEnabled: false,
      download: { fetchImpl: okFetch(new Uint8Array([1, 2])), cacheDir },
    })
    expect(r.images.length).toBe(1)
    expect(r.imageBlocks.length).toBe(0)
    expect(r.text).toContain('check')
    expect(r.text).toContain('[Image attachment: photo.jpg]')
  })

  test('multiple images cached in order', async () => {
    const msg = makeMsg({
      attachments: [
        {
          id: 'a1',
          filename: '1.png',
          url: 'https://cdn/1.png',
          contentType: 'image/png',
          size: 1,
        },
        {
          id: 'a2',
          filename: '2.png',
          url: 'https://cdn/2.png',
          contentType: 'image/png',
          size: 1,
        },
      ],
    })
    const r = await adaptDiscordMessage(msg, {
      promptText: 'p',
      visionEnabled: true,
      download: { fetchImpl: okFetch(new Uint8Array([9])), cacheDir },
    })
    expect(r.images.length).toBe(2)
    expect(r.images.map(i => i.filename)).toEqual(['1.png', '2.png'])
  })
})

describe('adaptDiscordMessage — non-image attachments', () => {
  test('PDF is skipped but noted in prompt', async () => {
    const msg = makeMsg({
      attachments: [
        {
          id: 'a',
          filename: 'report.pdf',
          url: 'https://cdn/report.pdf',
          contentType: 'application/pdf',
          size: 5,
        },
      ],
    })
    const r = await adaptDiscordMessage(msg, {
      promptText: 'look',
      visionEnabled: true,
      download: { fetchImpl: okFetch(new Uint8Array([1])), cacheDir },
    })
    expect(r.otherAttachments.length).toBe(1)
    expect(r.images.length).toBe(0)
    expect(r.text).toContain('[Attached (not processed): report.pdf]')
  })
})

describe('adaptDiscordMessage — download failures', () => {
  test('failed image download → failed list + failure hint in text', async () => {
    const failingFetch = (async () =>
      new Response('', { status: 500 })) as unknown as typeof fetch
    const msg = makeMsg({
      attachments: [
        {
          id: 'a',
          filename: 'broken.png',
          url: 'https://cdn/broken.png',
          contentType: 'image/png',
          size: 1,
        },
      ],
    })
    const r = await adaptDiscordMessage(msg, {
      promptText: 'please',
      visionEnabled: true,
      download: { fetchImpl: failingFetch, cacheDir },
    })
    expect(r.images.length).toBe(0)
    expect(r.imageBlocks.length).toBe(0)
    expect(r.failedAttachments.length).toBe(1)
    expect(r.text).toContain('[Attachment download failed: broken.png')
  })
})
