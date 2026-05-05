// Shared: detect & translate llama.cpp / TCQ-shim context-overflow errors into
// Anthropic "Prompt is too long" so QueryEngine reactive compaction can fire.
// Lifted from llamacpp-fetch-adapter.ts (line ~1995). Both adapters reuse.

/**
 * llama.cpp / TCQ-shim 的 context overflow 錯誤訊息措辭不一，這個 regex 涵蓋
 * 常見 variant：context length / n_ctx / prompt token / exceed / too long / out of。
 * 命中時把 OpenAI error 改寫成 Anthropic invalid_request_error + "Prompt is too long"
 * 觸發 src/services/api/errors.ts:isPromptTooLongMessage 走 reactive autocompact。
 */
export const CONTEXT_OVERFLOW_RE =
  /(context|n_ctx|prompt|token)[^a-z]*(length|exceed|too (long|large|many)|out of)/i

export function isContextOverflowError(status: number, errText: string): boolean {
  // TCQ-shim 直接回 413 + code=context_length_exceeded
  if (status === 413) return true
  // vanilla buun-llama-cpp 回 400 + body 含關鍵字
  return status === 400 && CONTEXT_OVERFLOW_RE.test(errText)
}

/** Build the Anthropic-shaped error response that QueryEngine recognizes. */
export function buildPromptTooLongResponse(status: number, errText: string): Response {
  const overflow = isContextOverflowError(status, errText)
  const message = overflow
    ? `Prompt is too long (llama.cpp): ${errText}`
    : `llama.cpp error (${status}): ${errText}`
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: overflow ? 'invalid_request_error' : 'api_error',
        message,
      },
    }),
    {
      status: overflow ? 400 : status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}
