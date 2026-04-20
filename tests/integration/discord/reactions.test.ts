/**
 * M-DISCORD-3b：reactions 測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  createReactionController,
  REACTION_ABORTED,
  REACTION_FAILURE,
  REACTION_SUCCESS,
  REACTION_THINKING,
} from '../../../src/discord/reactions'
import type { DiscordChannelSink } from '../../../src/discord/types'

function mockSink(): {
  sink: DiscordChannelSink
  calls: Array<['add' | 'remove', string, string]>
} {
  const calls: Array<['add' | 'remove', string, string]> = []
  return {
    calls,
    sink: {
      async send() {
        return { messageId: 'mock' }
      },
      async addReaction(id, emoji) {
        calls.push(['add', id, emoji])
      },
      async removeReaction(id, emoji) {
        calls.push(['remove', id, emoji])
      },
    },
  }
}

describe('ReactionController', () => {
  test('turnStart adds 👀', async () => {
    const { sink, calls } = mockSink()
    const rc = createReactionController(sink)
    await rc.onTurnStart({ channelId: 'c', messageId: 'm1' })
    expect(calls).toEqual([['add', 'm1', REACTION_THINKING]])
  })

  test('turnEnd done removes 👀 + adds ✅', async () => {
    const { sink, calls } = mockSink()
    const rc = createReactionController(sink)
    await rc.onTurnStart({ channelId: 'c', messageId: 'm1' })
    await rc.onTurnEnd({ channelId: 'c', messageId: 'm1' }, 'done')
    expect(calls).toEqual([
      ['add', 'm1', REACTION_THINKING],
      ['remove', 'm1', REACTION_THINKING],
      ['add', 'm1', REACTION_SUCCESS],
    ])
  })

  test('turnEnd error → ❌', async () => {
    const { sink, calls } = mockSink()
    const rc = createReactionController(sink)
    await rc.onTurnEnd({ channelId: 'c', messageId: 'm1' }, 'error')
    expect(calls).toEqual([
      ['remove', 'm1', REACTION_THINKING],
      ['add', 'm1', REACTION_FAILURE],
    ])
  })

  test('turnEnd aborted → ⏹️', async () => {
    const { sink, calls } = mockSink()
    const rc = createReactionController(sink)
    await rc.onTurnEnd({ channelId: 'c', messageId: 'm1' }, 'aborted')
    expect(calls).toEqual([
      ['remove', 'm1', REACTION_THINKING],
      ['add', 'm1', REACTION_ABORTED],
    ])
  })

  test('swallows sink errors; log only records successful ops', async () => {
    const log: Array<['add' | 'remove', string, string]> = []
    const sink: DiscordChannelSink = {
      async send() {
        return { messageId: 'mock' }
      },
      async addReaction(id, emoji) {
        if (emoji === REACTION_THINKING) throw new Error('rate limited')
        log.push(['add', id, emoji])
      },
      async removeReaction(id, emoji) {
        log.push(['remove', id, emoji])
      },
    }
    const rc = createReactionController(sink)
    // 不會 throw
    await rc.onTurnStart({ channelId: 'c', messageId: 'm1' })
    await rc.onTurnEnd({ channelId: 'c', messageId: 'm1' }, 'done')
    expect(log).toEqual([
      ['remove', 'm1', REACTION_THINKING],
      ['add', 'm1', REACTION_SUCCESS],
    ])
    expect(rc.log).toEqual([
      ['remove', 'm1', REACTION_THINKING],
      ['add', 'm1', REACTION_SUCCESS],
    ])
  })
})
