/**
 * M-DISCORD-3b：streamOutput 測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  createStreamOutputController,
  extractAssistantText,
} from '../../../src/discord/streamOutput'
import type { DiscordChannelSink } from '../../../src/discord/types'

interface MockSend {
  content: string
  replyToId?: string
  files?: string[]
}

function mockSink(): { sink: DiscordChannelSink; sends: MockSend[] } {
  const sends: MockSend[] = []
  return {
    sends,
    sink: {
      async send(p) {
        sends.push(p)
        return { messageId: `msg-${sends.length}` }
      },
      async addReaction() {},
      async removeReaction() {},
    },
  }
}

const assistantMsg = (text: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})

describe('extractAssistantText', () => {
  test('pulls text blocks', () => {
    expect(extractAssistantText(assistantMsg('hello'))).toBe('hello')
  })
  test('concatenates multiple text blocks', () => {
    expect(
      extractAssistantText({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'foo' },
            { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
            { type: 'text', text: ' bar' },
          ],
        },
      }),
    ).toBe('foo bar')
  })
  test('non-assistant type returns empty', () => {
    expect(extractAssistantText({ type: 'user', message: { content: [] } })).toBe('')
  })
  test('null / undefined / non-object → empty', () => {
    expect(extractAssistantText(null)).toBe('')
    expect(extractAssistantText(undefined)).toBe('')
    expect(extractAssistantText('string')).toBe('')
  })
  test('string content provider format', () => {
    expect(
      extractAssistantText({ type: 'assistant', message: { content: 'raw str' } }),
    ).toBe('raw str')
  })
})

describe('StreamOutputController — turn-end done', () => {
  test('accumulates text across multiple outputs, sends once at finalize', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({ sink, sourceMessageId: 'src-1' })
    c.handleOutput(assistantMsg('hello '))
    c.handleOutput(assistantMsg('world'))
    expect(c.accumulatedText).toBe('hello world')
    expect(sends.length).toBe(0)
    const result = await c.finalize('done')
    expect(sends.length).toBe(1)
    expect(sends[0]!.content).toBe('hello world')
    expect(sends[0]!.replyToId).toBe('src-1')
    expect(result.length).toBe(1)
  })

  test('empty output → no send', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({ sink, sourceMessageId: 'src-1' })
    await c.finalize('done')
    expect(sends.length).toBe(0)
  })

  test('replyMode first only sets replyToId on first chunk', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({
      sink,
      sourceMessageId: 'src-1',
      maxLength: 20, // force multi-chunk
      replyMode: 'first',
    })
    c.handleOutput(assistantMsg('aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd'))
    await c.finalize('done')
    expect(sends.length).toBeGreaterThanOrEqual(2)
    expect(sends[0]!.replyToId).toBe('src-1')
    for (let i = 1; i < sends.length; i++) {
      expect(sends[i]!.replyToId).toBeUndefined()
    }
  })

  test('replyMode all sets replyToId on every chunk', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({
      sink,
      sourceMessageId: 'src-1',
      maxLength: 20,
      replyMode: 'all',
    })
    c.handleOutput(assistantMsg('aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd'))
    await c.finalize('done')
    expect(sends.length).toBeGreaterThanOrEqual(2)
    for (const s of sends) {
      expect(s.replyToId).toBe('src-1')
    }
  })

  test('replyMode off never sets replyToId', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({
      sink,
      sourceMessageId: 'src-1',
      replyMode: 'off',
    })
    c.handleOutput(assistantMsg('hi'))
    await c.finalize('done')
    expect(sends.length).toBe(1)
    expect(sends[0]!.replyToId).toBeUndefined()
  })
})

describe('StreamOutputController — error / aborted', () => {
  test('error appends ❌ message', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({ sink, sourceMessageId: 'src-1' })
    c.handleOutput(assistantMsg('partial output'))
    await c.finalize('error', 'boom')
    expect(sends.length).toBe(1)
    expect(sends[0]!.content).toContain('partial output')
    expect(sends[0]!.content).toContain('❌')
    expect(sends[0]!.content).toContain('boom')
  })

  test('error with no accumulated text still sends error', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({ sink, sourceMessageId: 'src-1' })
    await c.finalize('error', 'boom')
    expect(sends.length).toBe(1)
    expect(sends[0]!.content.startsWith('❌')).toBe(true)
  })

  test('aborted sends ⏹️ hint', async () => {
    const { sink, sends } = mockSink()
    const c = createStreamOutputController({ sink, sourceMessageId: 'src-1' })
    c.handleOutput(assistantMsg('partial '))
    await c.finalize('aborted')
    expect(sends.length).toBe(1)
    expect(sends[0]!.content).toContain('⏹️')
    expect(sends[0]!.content).toContain('partial')
  })
})

describe('StreamOutputController — send failure handling', () => {
  test('send throws on second chunk → first chunk preserved, error swallowed', async () => {
    let callCount = 0
    const sends: MockSend[] = []
    const sink: DiscordChannelSink = {
      async send(p) {
        callCount++
        if (callCount === 2) throw new Error('rate limit')
        sends.push(p)
        return { messageId: `m${callCount}` }
      },
      async addReaction() {},
      async removeReaction() {},
    }
    const c = createStreamOutputController({
      sink,
      sourceMessageId: 'src-1',
      maxLength: 10,
    })
    c.handleOutput(assistantMsg('a'.repeat(50)))
    // finalize 不 throw
    const result = await c.finalize('done')
    expect(result.length).toBe(1)
    expect(sends.length).toBe(1)
  })
})
