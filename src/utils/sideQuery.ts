import type Anthropic from 'my-agent-ai/sdk'
import type { BetaToolUnion } from 'my-agent-ai/sdk/resources/beta/messages'
import { sideQueryViaLlamaCpp } from '../services/api/llamacppSideQuery.js'
import type { QuerySource } from '../constants/querySource.js'

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat

export type SideQueryOptions = {
  /**
   * Model name kept in the signature for API compatibility but ignored at
   * runtime — sideQuery is now llama.cpp-only and uses the model from
   * `~/.my-agent/llamacpp.json`. See ADR-014 + Phase 3 of the dapper-sonnet plan.
   */
  model: string
  /** System prompt — string or array of text blocks. */
  system?: string | TextBlockParam[]
  /** Messages to send. */
  messages: MessageParam[]
  /** Optional tools (translated to OpenAI function-calling format). */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice. */
  tool_choice?: ToolChoice
  /**
   * Optional JSON output format — degraded to prompt-only steering on llama.cpp
   * (no structured-outputs beta available). Callers must handle parse failures.
   */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024). */
  max_tokens?: number
  /** Max retries (kept for signature compat; llama.cpp adapter does not retry). */
  maxRetries?: number
  /** Abort signal. */
  signal?: AbortSignal
  /** Kept for signature compat; no Anthropic-only attribution path remains. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override. */
  temperature?: number
  /**
   * Thinking budget — ignored on llama.cpp (the adapter surfaces
   * `reasoning_content` automatically when the model emits it).
   */
  thinking?: number | false
  /** Stop sequences. */
  stop_sequences?: string[]
  /** Attribution tag — retained for log readability across providers. */
  querySource: QuerySource
}

/**
 * Lightweight LLM call wrapper for "side queries" outside the main
 * conversation loop (permission classifier, session search, model validation,
 * memory selector, name generator, etc).
 *
 * **llama.cpp-only since Phase 3 of dapper-sonnet plan.** The Anthropic SDK
 * path was removed — sideQuery now talks straight to the local llama.cpp
 * server (OpenAI-compatible `/v1/chat/completions`) via
 * `sideQueryViaLlamaCpp`. This keeps utility-level traffic off Anthropic
 * billing entirely and means a missing `ANTHROPIC_API_KEY` no longer breaks
 * permission auto-mode, memory recall, cron NL parsing, etc.
 *
 * Main-conversation turns are NOT affected — those still flow through
 * `queryModelWithStreaming` and respect the user's `--model` selection.
 *
 * Signature is preserved verbatim so the 8+ existing callers do not need to
 * change. `model` / `thinking` / `output_format` are accepted but ignored or
 * downgraded to prompt-only steering inside the adapter.
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  return sideQueryViaLlamaCpp(opts)
}
