/**
 * M-DISCORD-3b：RunnerEvent 流 → Discord message。
 *
 * 策略（預設 `turn-end`）：
 *   - 整個 turn 中累積 assistant content blocks 的 text 部分
 *   - turnEnd done → truncate 成多段 + 用 replyMode 控制 reply ref → sink.send
 *   - turnEnd error → 送 ❌ 開頭的錯誤訊息
 *   - turnEnd aborted → 送 ⏹️ 開頭的取消訊息
 *
 * tool_use / tool_result / thinking 內容**不**丟 Discord（太吵、也可能漏 secret）；
 * 使用者想看細節去看 session JSONL 或 REPL attach。
 *
 * Edit 策略（`edit`）未實作 — Hermes 那邊有節流 edit，M-DISCORD 第一版先省。
 */
import type { DiscordChannelSink } from './types.js'
import {
  DISCORD_MAX_LENGTH,
  truncateForDiscord,
} from './truncate.js'

export type StreamReplyMode = 'first' | 'all' | 'off'

export interface StreamOutputOptions {
  sink: DiscordChannelSink
  /** 使用者訊息 id（用來加 reply reference）。 */
  sourceMessageId: string
  /** replyMode 控制。預設 'first'。 */
  replyMode?: StreamReplyMode
  /** truncate 上限，預設 2000。 */
  maxLength?: number
}

export interface StreamOutputController {
  /** 接收 runnerEvent.output — 吃 SDKMessage，累積 assistant text。 */
  handleOutput(sdkMessage: unknown): void
  /** turnEnd：依 reason 送出最終訊息。done 送累積文字；error/aborted 送提示。 */
  finalize(reason: 'done' | 'error' | 'aborted', errorMsg?: string): Promise<
    ReadonlyArray<{ messageId: string }>
  >
  /** 測試用：目前累積到的文字。 */
  readonly accumulatedText: string
}

export function extractAssistantText(sdkMessage: unknown): string {
  if (!sdkMessage || typeof sdkMessage !== 'object') return ''
  const m = sdkMessage as {
    type?: unknown
    message?: { content?: unknown }
  }
  if (m.type !== 'assistant') return ''
  const content = m.message?.content
  if (!Array.isArray(content)) {
    // 有些 SDK message 把 content 放 string（某些 provider 格式）
    if (typeof content === 'string') return content
    return ''
  }
  const pieces: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      pieces.push(block.text)
    }
  }
  return pieces.join('')
}

export function createStreamOutputController(
  opts: StreamOutputOptions,
): StreamOutputController {
  const replyMode = opts.replyMode ?? 'first'
  const maxLength = opts.maxLength ?? DISCORD_MAX_LENGTH
  let accumulated = ''

  const shouldReply = (chunkIndex: number): boolean => {
    if (replyMode === 'off') return false
    if (replyMode === 'all') return true
    return chunkIndex === 0 // 'first'
  }

  const sendChunks = async (
    text: string,
  ): Promise<Array<{ messageId: string }>> => {
    if (text.trim().length === 0) return []
    const chunks = truncateForDiscord(text, { maxLength })
    const results: Array<{ messageId: string }> = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      try {
        const r = await opts.sink.send({
          content: chunk,
          replyToId: shouldReply(i) ? opts.sourceMessageId : undefined,
        })
        results.push(r)
      } catch (e) {
        // 送失敗就停；已送的先 return，不追加錯誤 reaction（由 reactions 控）。
        // 不 throw 讓 caller 流程繼續。
        // eslint-disable-next-line no-console
        console.error(
          `[discord:streamOutput] send failed at chunk ${i}/${chunks.length}: ${e instanceof Error ? e.message : String(e)}`,
        )
        break
      }
    }
    return results
  }

  return {
    get accumulatedText() {
      return accumulated
    },
    handleOutput(sdkMessage) {
      const text = extractAssistantText(sdkMessage)
      if (text) accumulated += text
    },
    async finalize(reason, errorMsg) {
      if (reason === 'done') {
        return sendChunks(accumulated)
      }
      if (reason === 'error') {
        const msg = `❌ Turn failed: ${errorMsg ?? 'unknown error'}`
        return sendChunks(accumulated ? `${accumulated}\n\n${msg}` : msg)
      }
      // aborted
      const msg = `⏹️ Turn aborted.`
      return sendChunks(accumulated ? `${accumulated}\n\n${msg}` : msg)
    },
  }
}
