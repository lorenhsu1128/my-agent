/**
 * M-DISCORD-3b：Reaction 狀態反饋 — port 自 Hermes `on_processing_start` /
 * `on_processing_complete`。
 *
 *   - `turnStart`     → 加 👀（正在思考）
 *   - `turnEnd` done  → 移 👀、加 ✅
 *   - `turnEnd` error → 移 👀、加 ❌
 *   - `turnEnd` aborted → 移 👀、加 ⏹️
 */
import type { DiscordChannelSink, ReactionTarget } from './types.js'

export const REACTION_THINKING = '👀'
export const REACTION_SUCCESS = '✅'
export const REACTION_FAILURE = '❌'
export const REACTION_ABORTED = '⏹️'

export interface ReactionController {
  onTurnStart(target: ReactionTarget): Promise<void>
  onTurnEnd(
    target: ReactionTarget,
    reason: 'done' | 'error' | 'aborted',
  ): Promise<void>
  /** 測試用：被呼叫的 reaction log。 */
  readonly log: ReadonlyArray<
    ['add' | 'remove', string, string] // [op, messageId, emoji]
  >
}

export function createReactionController(
  sink: DiscordChannelSink,
): ReactionController {
  const log: Array<['add' | 'remove', string, string]> = []

  const addReaction = async (msgId: string, emoji: string): Promise<void> => {
    try {
      await sink.addReaction(msgId, emoji)
      log.push(['add', msgId, emoji])
    } catch {
      // reaction 失敗不影響主流程（可能訊息被刪 / 權限不足）；吞掉即可
    }
  }
  const removeReaction = async (
    msgId: string,
    emoji: string,
  ): Promise<void> => {
    try {
      await sink.removeReaction(msgId, emoji)
      log.push(['remove', msgId, emoji])
    } catch {
      // 同上
    }
  }

  return {
    log,
    async onTurnStart(target) {
      await addReaction(target.messageId, REACTION_THINKING)
    },
    async onTurnEnd(target, reason) {
      await removeReaction(target.messageId, REACTION_THINKING)
      if (reason === 'done') {
        await addReaction(target.messageId, REACTION_SUCCESS)
      } else if (reason === 'error') {
        await addReaction(target.messageId, REACTION_FAILURE)
      } else {
        await addReaction(target.messageId, REACTION_ABORTED)
      }
    },
  }
}
