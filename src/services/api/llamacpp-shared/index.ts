// Barrel for shared llama.cpp adapter utilities.
// Both vanilla (llamacpp-fetch-adapter.ts) and TCQ-shim (tcq-shim-fetch-adapter.ts)
// import from here so they don't drift apart on the parts that are truly identical
// (request translation, non-streaming response translation, SSE iteration,
// retry nudge, context overflow detection, watchdog hook).
//
// Files physically lifted: sse-iter.ts, context-overflow.ts.
// Other shared functions live in llamacpp-fetch-adapter.ts (marked `export`)
// and are re-exported through this barrel — they have many internal helpers
// that aren't worth physically moving while existing tests are coupled to them.

export {
  formatSSE,
  iterOpenAISSELines,
  jsonStringifyAsciiSafe,
} from './sse-iter.js'

export {
  CONTEXT_OVERFLOW_RE,
  buildPromptTooLongResponse,
  isContextOverflowError,
} from './context-overflow.js'

// Re-exported from vanilla adapter (kept there to avoid churn on existing
// integration tests that import these directly):
export {
  translateRequestToOpenAI,
  translateMessagesToOpenAI,
  translateChatCompletionToAnthropic,
  translateOpenAIStreamToAnthropic,
  streamWithRetryOnEmptyTool,
  TOOL_USAGE_POLICY_NUDGE,
  RETRY_TOOL_NUDGE,
  observeSseChunk,
  sanitizeForTokenizer,
  deepSanitizeStrings,
  type LlamaCppConfig,
} from '../llamacpp-fetch-adapter.js'
