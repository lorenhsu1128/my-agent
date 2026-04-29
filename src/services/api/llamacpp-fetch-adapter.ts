/**
 * LlamaCpp Fetch Adapter（路徑 B）
 *
 * 攔截 Anthropic SDK 打到 /v1/messages 的 fetch 呼叫，翻譯成 OpenAI Chat
 * Completions API 格式，轉發到本地 llama.cpp server，再把回應翻譯回
 * Anthropic Messages 形狀。SDK 與下游（QueryEngine、StreamingToolExecutor）
 * 完全無感，程式碼路徑維持 Anthropic schema。
 *
 * 設計決策（DEPLOYMENT_PLAN.md M1 階段二實作 plan / ADR-005 / ADR-006）：
 *  - 不 import my-agent-ai/sdk 型別；inline 自定義 interface，邊界乾淨。
 *  - reasoning_content → thinking content block（語意符合 Qwen3.5-Neo
 *    的 CoT 分離）。
 *  - finish_reason → stop_reason：stop→end_turn / length→max_tokens /
 *    tool_calls→tool_use。
 *
 * 本檔範圍（階段二）：
 *  - 完整 non-streaming 翻譯（請求 + 回應）
 *  - 完整串流翻譯（純文字 + thinking），見 translateOpenAIStreamToAnthropic
 *  - 工具翻譯：函數簽名預留，實作留階段三
 */

// ── 型別（inline，不 import SDK）────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: { type?: string; media_type?: string; data?: string }
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface AnthropicRequestBody {
  model?: string
  system?: string | Array<{ type?: string; text?: string }>
  messages?: AnthropicMessage[]
  tools?: AnthropicTool[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  [key: string]: unknown
}

/**
 * M-VISION：當 vision 啟用且 user message 含 image block 時，
 * content 會是 multi-part array（OpenAI vision API 格式）。
 * 純文字路徑仍用 string | null。
 */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIMessage {
  role: string
  content: string | null | OpenAIContentPart[]
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface OpenAIRequestBody {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters: Record<string, unknown>
    }
  }>
  tool_choice?: 'auto' | 'none' | 'required' | {
    type: 'function'
    function: { name: string }
  }
}

interface OpenAIChatCompletion {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens?: number
    // M-TOKEN: llama.cpp 與 OpenAI 2024-10+ 規格回傳 KV-cache 命中 tokens。
    // 語意等同 Anthropic 的 cache_read_input_tokens。舊版 llama.cpp 不回此欄位。
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

interface OpenAIStreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // M-TOKEN: 見上方同欄位註解。
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

// ── 映射表 & helpers ─────────────────────────────────────────────────────

const FINISH_TO_STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
}

function mkMsgId(): string {
  return `msg_llamacpp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 把 Anthropic 的 system（字串或 blocks）扁平化為單一字串。
 */
function flattenSystemPrompt(
  system: AnthropicRequestBody['system'],
): string {
  if (!system) return ''
  if (typeof system === 'string') return sanitizeForTokenizer(system)
  return sanitizeForTokenizer(
    system.map(b => b.text ?? '').filter(Boolean).join('\n'),
  )
}

/**
 * 移除會讓 llama.cpp tokenizer 噴 "Failed to tokenize prompt" 的控制字元。
 * 主要是 NULL byte (\x00)，外加其他常見 stream-corrupt 的非列印控制字元。
 * 觀察到 cli-dev compile binary 在 git log 拼接 system prompt 時偶發
 * 4-byte UTF-8 變 9-byte 含 NULL 的 corruption；root cause 待查，先 sanitize。
 */
export function sanitizeForTokenizer(s: string): string {
  // 保留 \t \n \r；剝其他 C0 + DEL；不動高 unicode（可能是合法的 CJK / emoji）
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

/**
 * Recursive sanitize：遍歷 body 任何 string 欄位，剝 C0 控制字元。
 * 跳過 url 欄位（image_url.url 的 data:URL base64 內可能有 0x7F 之類，不該動）。
 * 跳過 data 欄位（base64 image source data 一樣不該動）。
 */
export function deepSanitizeStrings(obj: unknown): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i]
      if (typeof v === 'string') obj[i] = sanitizeForTokenizer(v)
      else if (v && typeof v === 'object') deepSanitizeStrings(v)
    }
    return
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    for (const k of Object.keys(o)) {
      // 跳過 base64 / URL 欄位 — 它們的 byte 值可能落在 C0 範圍但是合法資料
      if (k === 'url' || k === 'data') continue
      const v = o[k]
      if (typeof v === 'string') o[k] = sanitizeForTokenizer(v)
      else if (v && typeof v === 'object') deepSanitizeStrings(v)
    }
  }
}

// ── 請求翻譯：Anthropic → OpenAI ──────────────────────────────────────────

/**
 * M-VISION: Anthropic image block → OpenAI image_url content part。
 * Base64 source 組成 data URL；URL source 直接 pass-through。
 * 不認識的 source 型別回傳 null，呼叫端改塞文字佔位符。
 */
export function imageBlockToOpenAIPart(
  block: AnthropicContentBlock,
): OpenAIContentPart | null {
  const src = block.source
  if (!src || typeof src !== 'object') return null
  if (src.type === 'base64' && typeof src.data === 'string' && src.data) {
    const mediaType = src.media_type || 'image/png'
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${src.data}` },
    }
  }
  const url = (src as { url?: unknown }).url
  if (src.type === 'url' && typeof url === 'string' && url) {
    return { type: 'image_url', image_url: { url } }
  }
  return null
}

/**
 * 把 Anthropic messages 陣列轉成 OpenAI chat messages 陣列。
 * 處理 text / tool_use / tool_result / image。
 *
 * options.vision（M-VISION）：
 *   false（預設）→ image block 以 `[Image attachment]` 字串佔位（純文字模型 fallback）
 *   true         → image block 翻成 OpenAI `image_url` multi-part content
 */
export function translateMessagesToOpenAI(
  anthropicMessages: AnthropicMessage[],
  options: { vision?: boolean } = {},
): OpenAIMessage[] {
  const vision = options.vision === true
  const out: OpenAIMessage[] = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const textParts: string[] = []
      const imageParts: OpenAIContentPart[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Anthropic tool_result → OpenAI role:'tool' message
          let resultText = ''
          if (typeof block.content === 'string') {
            resultText = block.content
          } else if (Array.isArray(block.content)) {
            resultText = block.content
              .map(b => (b.type === 'text' ? b.text ?? '' : ''))
              .join('')
          }
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content: resultText,
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'image') {
          if (vision) {
            const part = imageBlockToOpenAIPart(block)
            if (part) {
              imageParts.push(part)
              continue
            }
          }
          textParts.push('[Image attachment]')
        }
      }
      if (imageParts.length > 0) {
        // Vision 路徑：多部分 content（text + image_url parts）
        const parts: OpenAIContentPart[] = []
        if (textParts.length > 0) {
          parts.push({ type: 'text', text: textParts.join('\n') })
        }
        parts.push(...imageParts)
        out.push({ role: 'user', content: parts })
      } else if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') })
      }
    } else {
      // assistant
      const textParts: string[] = []
      const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
        // thinking blocks 從 assistant 歷史訊息傳回時忽略（OpenAI 無對應欄位）
      }
      const asstMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
      }
      if (toolCalls.length > 0) asstMsg.tool_calls = toolCalls
      out.push(asstMsg)
    }
  }
  return out
}

/**
 * 把 Anthropic tool 定義轉成 OpenAI function 定義。
 * 本階段完整實作（階段三執行時會用到對話歷史翻譯）。
 */
function translateToolsToOpenAI(
  tools: AnthropicTool[] | undefined,
): OpenAIRequestBody['tools'] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * 組裝完整 OpenAI 請求 body。
 *
 * options.vision（M-VISION）：true 時 image block 翻成 OpenAI `image_url`；
 * 否則（預設）走 `[Image attachment]` 字串佔位符路徑，對純文字模型無縫 fallback。
 */
export function translateRequestToOpenAI(
  anthropic: AnthropicRequestBody,
  defaultModel: string,
  options: {
    vision?: boolean
    /**
     * M-LLAMACPP-WATCHDOG Phase 2：依 call-site clamp `max_tokens` 到設定上限。
     * 預設 `'turn'`（主對話）；背景呼叫應傳對應 callSite 走更嚴格 ceiling。
     * 只有 `tokenCap` watchdog 啟用時才生效；關閉時 `getTokenCap()` 回 Infinity 不影響。
     */
    callSite?: import('../../llamacppConfig/schema.js').LlamaCppCallSite
    /** 同上，可直接傳已 resolve 的 watchdog 設定（避免重讀 snapshot；測試友善） */
    watchdogCfg?: import('../../llamacppConfig/schema.js').LlamaCppWatchdogConfig
  } = {},
): OpenAIRequestBody {
  const systemPrompt = flattenSystemPrompt(anthropic.system)
  // 當 request 帶 tools 定義時，在 system prompt 尾端追加一句 tool-usage policy。
  // 觀察：本地 Qwen3.5 / Gemopus-4 有時會輸出「我來幫您查詢...」然後 finish_reason=stop
  // 而不 emit tool_use block（sampling 走了 text-only 分支）。追加一句明確指令
  // 降低這種「承諾卻不做」的機率。只在真的有 tools 時加，純對話不污染。
  const hasTools = Array.isArray(anthropic.tools) && anthropic.tools.length > 0
  const augmentedSystemPrompt = hasTools
    ? (systemPrompt ? systemPrompt + '\n\n' : '') + TOOL_USAGE_POLICY_NUDGE
    : systemPrompt
  const messages: OpenAIMessage[] = []
  if (augmentedSystemPrompt) {
    messages.push({ role: 'system', content: augmentedSystemPrompt })
  }
  messages.push(
    ...translateMessagesToOpenAI(anthropic.messages ?? [], {
      vision: options.vision,
    }),
  )

  // M-LLAMACPP-WATCHDOG Phase 2：max_tokens ceiling — caller_value 與
  // tokenCap[callSite] 取小值。watchdog 關閉時 cap=Infinity 等於不變。
  const callerMaxTokens = anthropic.max_tokens ?? 4096
  const callSite = options.callSite ?? 'turn'
  // lazy-load 以避免 vendored SDK 在 require 時撞 paths 解析（同檔頂層已 dynamic import 過 watchdog 模組）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const watchdogModule: typeof import('./llamacppWatchdog.js') = require('./llamacppWatchdog.js')
  const cfg =
    options.watchdogCfg ??
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../../llamacppConfig/loader.js') as typeof import('../../llamacppConfig/loader.js')).getEffectiveWatchdogConfig()
  const cap = watchdogModule.getTokenCap(cfg, callSite)
  const cappedMaxTokens = Math.min(callerMaxTokens, cap)

  const body: OpenAIRequestBody = {
    model: anthropic.model || defaultModel,
    messages,
    max_tokens: cappedMaxTokens,
    stream: anthropic.stream === true,
  }
  if (typeof anthropic.temperature === 'number') body.temperature = anthropic.temperature
  if (typeof anthropic.top_p === 'number') body.top_p = anthropic.top_p
  const tools = translateToolsToOpenAI(anthropic.tools)
  if (tools) {
    body.tools = tools
    // 明示 tool_choice='auto' — 雖然是 OpenAI 預設，但確保 llama.cpp server 在
    // tools 存在時仍把 tool-call 視為一等公民。配合 streamWithRetry 的
    // retry-on-empty-tool 降低 sampling 走 text-only 分支的機率。
    body.tool_choice = 'auto'
  }
  return body
}

/**
 * Tool-usage policy nudge — 只在 tools 陣列非空時追加到 system prompt 尾端。
 * 目的：避免本地 model 的 sampling 走 text-only 分支（例如「我來幫您查詢」後就
 * finish_reason=stop），明確告訴模型能用 tool 就必須 emit tool_use block。
 */
export const TOOL_USAGE_POLICY_NUDGE = `Tool usage policy: If a tool can answer the user's question, you MUST emit a tool_use block in the same turn. Do NOT answer with text-only intentions like "I will check ..." or "Let me look up ..." — either call the tool now, or answer fully without promising any tool call.`

// ── 回應翻譯：OpenAI → Anthropic（non-streaming）──────────────────────────

/**
 * 把 OpenAI ChatCompletion 翻譯成 Anthropic BetaMessage shape。
 * 規則（ADR-006）：
 *   message.reasoning_content → 一個 thinking content block（若非空）
 *   message.content           → 一個 text content block（若非空）
 *   message.tool_calls        → 多個 tool_use content block（若存在）
 * 順序：thinking → tool_use（若有）→ text
 */
function translateChatCompletionToAnthropic(
  openai: OpenAIChatCompletion,
  model: string,
): Record<string, unknown> {
  const choice = openai.choices[0]
  const content: AnthropicContentBlock[] = []

  const reasoning = choice.message.reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    content.push({ type: 'thinking', thinking: reasoning })
  }

  const toolCalls = choice.message.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      let parsedInput: Record<string, unknown> = {}
      try {
        parsedInput = JSON.parse(tc.function.arguments || '{}')
      } catch {
        parsedInput = { __raw_arguments__: tc.function.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      })
    }
  }

  const textContent = choice.message.content
  if (typeof textContent === 'string' && textContent.length > 0) {
    content.push({ type: 'text', text: textContent })
  }

  const stopReason = FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn'

  return {
    id: openai.id || mkMsgId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      // M-TOKEN: llama.cpp KV-cache 命中 tokens → Anthropic cache_read_input_tokens
      cache_read_input_tokens:
        openai.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  }
}

// ── SSE helpers ──────────────────────────────────────────────────────────

/**
 * 組 Anthropic SSE event line。格式：`event: <type>\ndata: <json>\n\n`
 */
/**
 * 把 non-ASCII 字元（U+0080+）轉成 `\uXXXX` JSON escape。
 * Anthropic SDK 的 SSE parser 內部 `decodeUTF8()` 不帶 `{stream: true}`，
 * ReadableStream chunk 邊界切到 multi-byte UTF-8（如中文 3-byte）中間時會
 * 產生 replacement char → JSON.parse 失敗 → tool input 變成 {}。
 * 用純 ASCII 的 JSON 徹底繞過這個問題。
 */
function jsonStringifyAsciiSafe(data: unknown): string {
  return JSON.stringify(data).replace(
    /[\u0080-\uffff]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${jsonStringifyAsciiSafe(data)}\n\n`
}

/**
 * 把 OpenAI SSE byte stream 拆成 line buffer，逐行 yield JSON 字串
 * （去掉 `data: ` 前綴，遇 `[DONE]` 停止）。
 */
async function* iterOpenAISSELines(
  upstream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = upstream.getReader()
  // 不用 TextDecoder({ stream: true })！Bun 1.3.6 Windows 的 streaming
  // TextDecoder 會在 chunk 邊界切碎 multi-byte UTF-8（例如中文 3-byte
  // 字元）→ 產生亂碼 → JSON.parse 失敗 → tool input 變成 {}。
  //
  // 改成：累積 raw bytes、在 \n (0x0a, ASCII single-byte) 切行、每完整行
  // 才 toString('utf-8')。SSE 的行分隔符 \n 是 single-byte，不可能切到
  // multi-byte 字元中間，所以每行內的 UTF-8 一定完整。
  let rawBuf = Buffer.alloc(0)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      rawBuf = Buffer.concat([rawBuf, Buffer.from(value)])
      let idx: number
      while ((idx = rawBuf.indexOf(0x0a)) !== -1) {
        const lineBytes = rawBuf.subarray(0, idx)
        rawBuf = rawBuf.subarray(idx + 1)
        const line = lineBytes.toString('utf-8').replace(/\r$/, '')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── 串流翻譯器：OpenAI SSE → Anthropic SSE ────────────────────────────────

/**
 * 核心狀態機：把 OpenAI chat completion chunks 翻譯成 Anthropic stream
 * events。支援純文字 + thinking（ADR-006）+ tool_use。
 *
 * 事件序列範例（有 tool call）：
 *   message_start
 *   [content_block_start(thinking) → thinking_delta × N → content_block_stop]
 *   [content_block_start(text) → text_delta × N → content_block_stop]
 *   [content_block_start(tool_use) → input_json_delta × N → content_block_stop] ×M
 *   message_delta(stop_reason=tool_use, usage)
 *   message_stop
 *
 * 狀態管理（階段三重構）：
 *   - textIndex / textType：最多一個開啟中的 text/thinking block
 *   - openToolBlocks：Map<openai tool_call index, anthropic block index>
 *     — 每個工具呼叫佔一個 content block，全部留到 stream 結束才關
 *   - nextBlockIndex：單調遞增的 Anthropic content block index 分配器
 */
async function* translateOpenAIStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  msgId: string,
  callSite: import('../../llamacppConfig/schema.js').LlamaCppCallSite = 'turn',
): AsyncGenerator<string> {
  let msgStarted = false
  let nextBlockIndex = 0
  let textIndex = -1
  let textType: 'text' | 'thinking' | null = null
  // debug 觀測：追蹤整個 stream 是否吐過 text / thinking / tool_calls（供
  // finish_reason 結束時診斷「承諾用工具卻沒 emit」的情境）
  let emittedText = false
  let emittedThinking = false
  let emittedToolCall = false
  // OpenAI tool_call.index → Anthropic content block index（開啟中的工具塊）
  const openToolBlocks = new Map<number, number>()
  // 每個 tool block 的 arguments 累積 buffer（openaiIdx → 累積字串）。
  // 在 content_block_stop 時一次 yield 完整 JSON 作為單一 input_json_delta，
  // 避免 Anthropic SDK 的 SSE parser 切碎跨 chunk 的 multi-byte UTF-8。
  const toolArgBuffers = new Map<number, string>()
  // M-TOKEN: 追加 cache_read_input_tokens 以便 message_delta 能帶給下游 updateUsage
  const accUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  }
  let finalFinishReason: string | null = null

  const startMessage = () => {
    msgStarted = true
    return formatSSE('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const stopBlock = (index: number) =>
    formatSSE('content_block_stop', {
      type: 'content_block_stop',
      index,
    })

  const closeTextBlock = (): string | null => {
    if (textIndex < 0) return null
    const out = stopBlock(textIndex)
    textIndex = -1
    textType = null
    return out
  }

  const openTextBlock = (kind: 'text' | 'thinking'): string => {
    textIndex = nextBlockIndex++
    textType = kind
    const content_block =
      kind === 'text'
        ? { type: 'text', text: '' }
        : { type: 'thinking', thinking: '' }
    return formatSSE('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block,
    })
  }

  // M-LLAMACPP-WATCHDOG：把 SSE 流包進 watchdog 監控。disabled / master off 時
  // watchSseStream 直接 passthrough，零 overhead。觸發時 throw WatchdogAbortError
  // → 我們 catch 後 yield message_delta + message_stop 收尾，讓 SDK 端拿到正常
  // stream 結束（非 fatal error）。watchdog 觸發的 console.warn 由 watchSseStream
  // 內部處理。
  const { getEffectiveWatchdogConfig } = await import(
    '../../llamacppConfig/loader.js'
  )
  const { watchSseStream, WatchdogAbortError } = await import(
    './llamacppWatchdog.js'
  )
  const watchdogCfg = getEffectiveWatchdogConfig()
  const watchdogCtrl = new AbortController()
  const watchedSse = watchSseStream(
    iterOpenAISSELines(upstream),
    watchdogCfg,
    callSite,
    watchdogCtrl,
  )

  let watchdogAborted: InstanceType<typeof WatchdogAbortError> | null = null

  try {
  for await (const payload of watchedSse) {
    let chunk: OpenAIStreamChunk
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk
    } catch {
      continue
    }

    if (!msgStarted) {
      yield startMessage()
    }

    const choice = chunk.choices?.[0]
    if (choice?.delta) {
      const { content, reasoning_content, tool_calls } = choice.delta

      // 1. thinking delta
      if (typeof reasoning_content === 'string' && reasoning_content.length > 0) {
        if (textType !== 'thinking') {
          const stop = closeTextBlock()
          if (stop) yield stop
          yield openTextBlock('thinking')
        }
        yield formatSSE('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'thinking_delta', thinking: reasoning_content },
        })
        emittedThinking = true
      }

      // 2. text delta
      if (typeof content === 'string' && content.length > 0) {
        if (textType !== 'text') {
          const stop = closeTextBlock()
          if (stop) yield stop
          yield openTextBlock('text')
        }
        yield formatSSE('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: content },
        })
        emittedText = true
      }

      // 3. tool_call deltas（可多筆，按 openai index 區分）
      if (Array.isArray(tool_calls) && tool_calls.length > 0) {
        emittedToolCall = true
        // 一旦進入 tool call，先關掉任何開啟的 text/thinking block
        // （OpenAI Chat Completions 串流實務上 text/reasoning 不與 tool_calls 交錯）
        if (textIndex >= 0) {
          yield stopBlock(textIndex)
          textIndex = -1
          textType = null
        }

        for (const tc of tool_calls) {
          const openaiIdx = tc.index ?? 0
          let anthropicIdx = openToolBlocks.get(openaiIdx)

          // 第一次見到這個 openai index：開 tool_use block
          if (anthropicIdx === undefined) {
            anthropicIdx = nextBlockIndex++
            openToolBlocks.set(openaiIdx, anthropicIdx)
            toolArgBuffers.set(openaiIdx, '')
            yield formatSSE('content_block_start', {
              type: 'content_block_start',
              index: anthropicIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id ?? `toolu_${Date.now()}_${openaiIdx}`,
                name: tc.function?.name ?? '',
                input: {},
              },
            })
          }

          // 累積 arguments chunk 到 buffer（不即時 yield input_json_delta）。
          // 原因：Anthropic SDK 的 SSE parser 內部用 decodeUTF8() 不帶
          // {stream: true}，跨 chunk 的 multi-byte UTF-8（如中文）會被切碎成亂碼。
          // 改成：在 adapter 層累積完整 arguments JSON 字串，在 content_block_stop
          // 時一次 yield 單一 input_json_delta — 單一 chunk 不會被切割。
          const argDelta = tc.function?.arguments
          if (typeof argDelta === 'string' && argDelta.length > 0) {
            toolArgBuffers.set(
              openaiIdx,
              (toolArgBuffers.get(openaiIdx) ?? '') + argDelta,
            )
          }
        }
      }
    }

    if (choice?.finish_reason) {
      finalFinishReason = choice.finish_reason
    }
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === 'number') {
        accUsage.input_tokens = chunk.usage.prompt_tokens
      }
      if (typeof chunk.usage.completion_tokens === 'number') {
        accUsage.output_tokens = chunk.usage.completion_tokens
      }
      // M-TOKEN: llama.cpp KV-cache 命中 tokens
      if (typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number') {
        accUsage.cache_read_input_tokens =
          chunk.usage.prompt_tokens_details.cached_tokens
      }
    }
  }

  // 收尾
  if (!msgStarted) {
    yield startMessage()
  }

  const lastTextStop = closeTextBlock()
  if (lastTextStop) yield lastTextStop

  // 關掉所有開啟中的 tool_use block。
  // 把 input_json_delta + content_block_stop 合併成**單一 string** yield。
  // Anthropic SDK 的 SSE parser 在 Bun Windows 上可能跨 ReadableStream chunk
  // 丟事件；把 delta + stop 塞進同一 chunk 就不會被拆開。
  for (const [openaiIdx, anthropicIdx] of openToolBlocks.entries()) {
    const fullArgs = toolArgBuffers.get(openaiIdx) ?? ''

    // 合併成一個字串：input_json_delta + content_block_stop（中間以 \n\n 分隔 SSE events）
    let combined = ''
    if (fullArgs.length > 0) {
      combined += formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: anthropicIdx,
        delta: { type: 'input_json_delta', partial_json: fullArgs },
      })
    }
    combined += formatSSE('content_block_stop', {
      type: 'content_block_stop',
      index: anthropicIdx,
    })
    yield combined // 單一 yield → 單一 chunk → SDK 一次 read 拿到全部
  }
  const finalToolBlockCount = openToolBlocks.size
  openToolBlocks.clear()
  toolArgBuffers.clear()

  // M-LLAMACPP-CTX: finish_reason=length + 0 output 是典型上下文溢出徵兆
  // （server 吃掉 prompt 但沒空間產 token）。寫一條 stderr 警示協助診斷。
  if (finalFinishReason === 'length' && accUsage.output_tokens === 0) {
    // biome-ignore lint/suspicious/noConsole: diagnostic only
    console.error(
      '[llamacpp] finish_reason=length 且 output_tokens=0；可能為上下文已滿或 n_ctx 不足。' +
        '若情況持續，確認 LLAMACPP_CTX_SIZE 與實際 /slots n_ctx 一致，或手動 /compact',
    )
  }

  } catch (err) {
    if (err instanceof WatchdogAbortError) {
      watchdogAborted = err
      // biome-ignore lint/suspicious/noConsole: user-visible diagnostic
      console.warn(
        `[llamacpp-watchdog] aborted layer=${err.layer} callSite=${err.stats.callSite} tokens=${err.stats.tokens} elapsedMs=${err.stats.elapsedMs} reason=${err.message}`,
      )
      // 補關掉任何開著的 content block，避免下游 SDK 看到不完整 stream
      if (textIndex >= 0) {
        yield stopBlock(textIndex)
        textIndex = -1
      }
      for (const idx of openToolBlocks.values()) {
        yield stopBlock(idx)
      }
      openToolBlocks.clear()
    } else {
      throw err
    }
  }

  // Stream 結束摘要：供診斷「模型承諾用工具但沒 emit」的症狀。若 finish=stop
  // + emittedText + !emittedToolCall 可判斷為模型 sampling 決定不呼叫工具
  // （不是 adapter bug）。只在 LLAMA_DEBUG 或 MY_AGENT_DEBUG 開啟時印。
  if (process.env.LLAMA_DEBUG || process.env.MY_AGENT_DEBUG) {
    // biome-ignore lint/suspicious/noConsole: diagnostic only
    console.error(
      `[llamacpp/stream-end] finish_reason=${finalFinishReason} text=${emittedText} thinking=${emittedThinking} tool_calls=${emittedToolCall} closed_tool_blocks=${finalToolBlockCount} out_tokens=${accUsage.output_tokens}`,
    )
  }
  yield formatSSE('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: watchdogAborted
        ? watchdogAborted.layer === 'tokenCap'
          ? 'max_tokens'
          : 'end_turn'
        : (FINISH_TO_STOP[finalFinishReason ?? ''] ?? 'end_turn'),
      stop_sequence: null,
    },
    // M-TOKEN: 除了 output_tokens 外，一併送回 input_tokens / cache_read_input_tokens
    // 讓 claude.ts:updateUsage() 能正確寫進 state（原本只送 output_tokens，
    // 下游 input/cache 保持啟始 0）。cache_creation llama.cpp 無概念，固定 0。
    usage: {
      output_tokens: accUsage.output_tokens,
      input_tokens: accUsage.input_tokens,
      cache_read_input_tokens: accUsage.cache_read_input_tokens,
      cache_creation_input_tokens: 0,
    },
  })
  yield formatSSE('message_stop', { type: 'message_stop' })
}

/**
 * 把 async generator 逐 yield push 進 ReadableStream，每個完整 SSE event
 * 成為獨立 chunk。
 *
 * 原本這裡攢整個 body 再一次送（看不到漸進式輸出）是為了繞 Anthropic SDK
 * SSE parser 在跨 chunk 切到 multi-byte UTF-8 時 decode 失敗的問題。但
 * `jsonStringifyAsciiSafe()`（見 `formatSSE`）已把所有非 ASCII escape 成
 * `\uXXXX`，每個 yield 都是純 ASCII 完整 `event: X\ndata: Y\n\n`；
 * UTF-8 切割風險已消失，可以安全逐 event 串流。
 *
 * 仍保留：`input_json_delta + content_block_stop` 在 translator 層合併成
 * 單一 yield（見 translateOpenAIStreamToAnthropic 收尾處）— 那是另一個
 * 獨立 workaround，不受此處影響。
 */
// ── Retry-on-empty-tool（中強度 nudge）────────────────────────────────────

/**
 * 觀察 translateOpenAIStreamToAnthropic 吐出的 SSE chunk，記錄：
 *   - text emitted（text_delta event）
 *   - tool_use emitted（input_json_delta 或 content_block_start type=tool_use）
 *   - stop_reason（從 message_delta event 的 delta.stop_reason 抽）
 * 用以判斷是否觸發 retry。
 */
export function observeSseChunk(
  chunk: string,
  state: { text: boolean; toolCall: boolean; stopReason: string | null },
): void {
  if (chunk.includes('"type":"text_delta"')) state.text = true
  if (
    chunk.includes('"type":"input_json_delta"') ||
    chunk.includes('"type":"tool_use"')
  ) {
    state.toolCall = true
  }
  if (chunk.includes('event: message_delta')) {
    const m = chunk.match(/"stop_reason":"([^"]+)"/)
    if (m) state.stopReason = m[1]!
  }
}

/**
 * 第二輪 retry 時追加的 user 訊息 — 明確指示模型必須 emit tool_use。
 */
export const RETRY_TOOL_NUDGE =
  'Your previous reply only stated an intention (e.g. "I will check ...") without emitting a tool_use block. You MUST call the appropriate tool NOW to fulfil the user request. Do not reply with text-only intentions again.'

/**
 * 中強度「retry-on-empty-tool」：當第一輪 streaming 結束後偵測到
 *   stop_reason=end_turn + text_emitted + !tool_use_emitted + tools_defined
 * 代表模型 sampling 走了 text-only 分支（「我來幫您查詢...」就停），此時
 * 丟掉第一輪 buffer、追加 user 重試訊息、再 fetch 第二輪。若第二輪仍失敗
 * 或 retry 端網路/server 錯，fallback 回第一輪 buffer 避免卡死。
 *
 * 代價：tools 存在的 streaming 請求會被完整 buffer 後才往下游 yield（失去
 * 漸進輸出的 UX）；換 correctness。不含 tools 的請求完全走原路徑。
 */
async function* streamWithRetryOnEmptyTool(
  firstBody: ReadableStream<Uint8Array>,
  endpoint: string,
  openaiBody: OpenAIRequestBody,
  reportedModel: string,
  apiKey?: string,
): AsyncGenerator<string> {
  const state1 = {
    text: false,
    toolCall: false,
    stopReason: null as string | null,
  }
  const msgId = mkMsgId()
  const firstBuffer: string[] = []
  for await (const chunk of translateOpenAIStreamToAnthropic(
    firstBody,
    reportedModel,
    msgId,
  )) {
    observeSseChunk(chunk, state1)
    firstBuffer.push(chunk)
  }

  // False-positive 保護：只在最後一則 message 是 user（= 這是新一輪 query、
  // 預期需要呼叫工具）時才 retry。如果最後一則是 assistant / tool，代表這輪
  // 是「拿到 tool result 後做 summary」，文字結束是正常行為，不該 retry。
  const lastMessage = openaiBody.messages[openaiBody.messages.length - 1]
  const lastIsUser = lastMessage?.role === 'user'

  const shouldRetry =
    state1.stopReason === 'end_turn' &&
    state1.text &&
    !state1.toolCall &&
    lastIsUser
  if (!shouldRetry) {
    for (const c of firstBuffer) yield c
    return
  }

  if (process.env.LLAMA_DEBUG || process.env.MY_AGENT_DEBUG) {
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.error(
      '[llamacpp/retry] triggered — text-only reply without tool_use, retrying with nudge',
    )
  }

  const retryOpenaiBody: OpenAIRequestBody = {
    ...openaiBody,
    messages: [
      ...openaiBody.messages,
      { role: 'user', content: RETRY_TOOL_NUDGE },
    ],
  }

  let retryRes: Response
  try {
    const retryHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (apiKey) retryHeaders['Authorization'] = `Bearer ${apiKey}`
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    retryRes = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers: retryHeaders,
      body: JSON.stringify(retryOpenaiBody),
    })
  } catch {
    for (const c of firstBuffer) yield c
    return
  }
  if (!retryRes.ok || !retryRes.body) {
    for (const c of firstBuffer) yield c
    return
  }

  // 第二輪：直接串流給下游（不 buffer；這輪是最後結果）。message_start 由
  // translator 自己吐，SDK 會看到第二個 message_start — 但因為第一輪 buffer
  // 整個被丟掉（沒有 yield），下游等同於只看見第二輪。
  for await (const chunk of translateOpenAIStreamToAnthropic(
    retryRes.body,
    reportedModel,
    mkMsgId(),
  )) {
    yield chunk
  }
}

function sseGeneratorToStream(
  gen: AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const value of gen) {
          controller.enqueue(encoder.encode(value))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

// ── 主 export：fetch 攔截器 ────────────────────────────────────────────────

export interface LlamaCppConfig {
  baseUrl: string
  model: string
  /** M-VISION: 啟用 image block → OpenAI image_url 翻譯 */
  vision?: boolean
}

/**
 * Daemon 多 project 模式：切換 project 時設為 true，adapter 會在下次
 * request 加 cache_prompt:false 強制 llama.cpp 不復用 KV cache。
 * 送出後自動 reset 為 false。
 */
let skipPromptCacheOnce = false
export function setSkipPromptCacheOnce(): void { skipPromptCacheOnce = true }

export function createLlamaCppFetch(
  config: LlamaCppConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // 只攔截 Anthropic Messages API 呼叫；其他請求照原樣走
    if (!url.includes('/v1/messages')) {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      return globalThis.fetch(input, init)
    }

    // M-LLAMACPP-REMOTE: per-call resolve routing.turn endpoint。
    // closure 裡的 config 只當 vision 旗標 + bootstrap fallback 用；baseUrl /
    // model / apiKey 每次 fetch 重新解析，下個 turn 改 routing 立刻生效。
    // resolveEndpoint 失敗（routing 指 remote 但 remote.enabled=false）→ 直接
    // throw 讓 SDK 看到原始錯誤，不 silent fallback。
    const { resolveEndpoint } = await import('../../llamacppConfig/index.js')
    const ep = resolveEndpoint('turn')
    const effectiveBaseUrl = ep.baseUrl
    const effectiveModel = ep.model
    const effectiveApiKey = ep.apiKey

    // 解析 Anthropic request body
    let anthropicBody: AnthropicRequestBody = {}
    let _rawBodyText = ''
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      _rawBodyText = bodyText
      anthropicBody = JSON.parse(bodyText) as AnthropicRequestBody
    } catch {
      anthropicBody = {}
    }
    // M-PROMPT-CORRUPTION-HUNT: dump raw body text BEFORE translate
    if (process.env.LLAMA_DUMP_RAWBODY && _rawBodyText) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs')
        const ts = Date.now()
        fs.writeFileSync(
          `${process.env.LLAMA_DUMP_RAWBODY}/raw-${ts}.json`,
          Buffer.from(_rawBodyText, 'utf-8'),
        )
        // Also dump just the system array element-by-element
        const sys = (anthropicBody as any).system
        if (sys) {
          fs.writeFileSync(
            `${process.env.LLAMA_DUMP_RAWBODY}/sys-array-${ts}.json`,
            Buffer.from(JSON.stringify(sys, null, 2), 'utf-8'),
          )
        }
      } catch {/* ignore */}
    }

    const openaiBody = translateRequestToOpenAI(anthropicBody, effectiveModel, {
      vision: config.vision === true,
    })
    // M-PROMPT-CORRUPTION-HUNT debug: dump pre-sanitize body to find corruption source
    if (process.env.LLAMA_DUMP_PRESANITIZE) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs')
        const ts = Date.now()
        const sysContent = (openaiBody.messages?.[0]?.content as string) || ''
        if (typeof sysContent === 'string' && sysContent.length > 0) {
          fs.writeFileSync(
            `${process.env.LLAMA_DUMP_PRESANITIZE}/sysprompt-${ts}.bin`,
            Buffer.from(sysContent, 'utf-8'),
          )
        }
      } catch {/* ignore */}
    }
    // M-PROMPT-CORRUPTION-HUNT auto-detect：unconditional check for C0 byte
    // before sanitize；命中即 dump 證據到 ~/.my-agent/corruption-evidence/
    // （無需 env var）。配合 sanitize 的 bandaid，user 不會看到 user-facing crash，
    // 但有資料供 root cause 調查。
    {
      const sysContent = (openaiBody.messages?.[0]?.content as string) || ''
      // 只 catch NULL byte（最 specific 的 corruption 標記，
      // 避開合法 ANSI escape \x1B / 其他 control char false positive）
      const hasNul = typeof sysContent === 'string' && sysContent.includes('\x00')
      if (hasNul) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('fs')
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const path = require('path')
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const os = require('os')
          const evidenceDir = path.join(os.homedir(), '.my-agent', 'corruption-evidence')
          fs.mkdirSync(evidenceDir, { recursive: true })
          const ts = Date.now()
          // 找第一個 NULL byte 位置 + 周圍 80 chars
          const idx = sysContent.indexOf('\x00')
          const ctxStart = Math.max(0, idx - 80)
          const ctxEnd = Math.min(sysContent.length, idx + 80)
          const byteIdx = Buffer.byteLength(sysContent.slice(0, idx), 'utf-8')
          const meta = {
            timestamp: new Date(ts).toISOString(),
            sysPromptLen: sysContent.length,
            sysPromptBytes: Buffer.byteLength(sysContent, 'utf-8'),
            firstNulCharIdx: idx,
            firstNulByte: byteIdx,
            contextBefore: sysContent.slice(ctxStart, idx),
            contextAt: sysContent.slice(idx, idx + 16),
            contextAfter: sysContent.slice(idx + 1, ctxEnd),
            contextBytesHex: Buffer.from(sysContent.slice(ctxStart, ctxEnd), 'utf-8').toString('hex'),
            cliVersion: process.env.npm_package_version || 'unknown',
            agentVersion: 'cli-dev',
            note: 'See docs/plans/M-PROMPT-CORRUPTION-HUNT.md for context',
          }
          fs.writeFileSync(
            path.join(evidenceDir, `meta-${ts}.json`),
            JSON.stringify(meta, null, 2),
          )
          fs.writeFileSync(
            path.join(evidenceDir, `sysprompt-${ts}.bin`),
            Buffer.from(sysContent, 'utf-8'),
          )
          // biome-ignore lint/suspicious/noConsole:: investigation breadcrumb
          console.error(
            `[M-PROMPT-CORRUPTION] NULL byte detected in system prompt (char ${idx}, byte ${byteIdx}). ` +
              `Evidence saved to ${evidenceDir}. Sanitizing before send...`,
          )
        } catch {/* ignore — sanitize will handle it anyway */}
      }
    }
    // Defense: 任何字串值含 \x00 或其他 C0 控制字元都會讓 llama.cpp tokenizer 失敗
    // （image multimodal 路徑特別敏感）。觀察到 cli-dev compile binary 偶發
    // git log 拼接時產生這種 corruption（4-byte un-l 變成 9-byte 含 NULL）。
    deepSanitizeStrings(openaiBody as unknown as Record<string, unknown>)
    const endpoint = `${effectiveBaseUrl.replace(/\/$/, '')}/chat/completions`
    const reportedModel = anthropicBody.model ?? effectiveModel

    if (process.env.LLAMA_DEBUG) {
      // biome-ignore lint/suspicious/noConsole:: debug
      console.error(
        '[LLAMA_DEBUG] request tools=',
        (openaiBody.tools ?? []).map(t => t.function.name).join(','),
        'msgs=',
        openaiBody.messages.length,
        'stream=',
        openaiBody.stream,
      )
    }
    // Temporary: dump full body to file for tokenize-error debugging.
    if (process.env.LLAMA_DUMP_BODY) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs')
        const ts = Date.now()
        const path = `${process.env.LLAMA_DUMP_BODY}/req-${ts}.json`
        // Truncate base64 image data so file isn't huge
        const sanitized = JSON.parse(JSON.stringify(openaiBody, (k, v) => {
          if (k === 'url' && typeof v === 'string' && v.startsWith('data:')) {
            return `${v.slice(0, 64)}...[truncated ${v.length} chars]`
          }
          return v
        }))
        fs.writeFileSync(path, JSON.stringify(sanitized, null, 2))
        // biome-ignore lint/suspicious/noConsole:: debug
        console.error(`[LLAMA_DUMP_BODY] wrote ${path}`)
      } catch (e) {
        // biome-ignore lint/suspicious/noConsole:: debug
        console.error(`[LLAMA_DUMP_BODY] dump failed:`, e)
      }
    }

    let openaiRes: Response
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: openaiBody.stream ? 'text/event-stream' : 'application/json',
      }
      if (effectiveApiKey) {
        headers['Authorization'] = `Bearer ${effectiveApiKey}`
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      openaiRes = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          skipPromptCacheOnce
            ? (() => { skipPromptCacheOnce = false; return { ...openaiBody, cache_prompt: false } })()
            : openaiBody,
        ),
      })
    } catch (err) {
      // 連線層失敗（server 沒跑、DNS 錯、網路斷）— 回一個 Anthropic shape
      // 的 error response，訊息指示使用者啟動本地 server
      const e = err as { code?: string; cause?: { code?: string }; message?: string }
      const code = e?.code ?? e?.cause?.code ?? ''
      const detail = e?.message ?? String(err)
      // 連線層失敗的各種訊息樣式（Node undici、Bun native fetch、各平台）
      const isConnErr =
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ENOTFOUND' ||
        /ECONNREFUSED|Unable to connect|fetch failed|ECONNRESET|ENOTFOUND/i.test(detail)
      const targetLabel =
        ep.target === 'remote' ? `routing=turn→remote (${effectiveBaseUrl})` : effectiveBaseUrl
      const hint = isConnErr
        ? ep.target === 'remote'
          ? `llama.cpp remote endpoint 連不上：${effectiveBaseUrl}。檢查網路 / remote.baseUrl / remote server 是否啟動，或將 routing.turn 改回 'local'。`
          : `llama.cpp server 未啟動於 ${effectiveBaseUrl}。請在另一個終端執行：\n  bash scripts/llama/serve.sh\n或設定 LLAMA_BASE_URL 指向已啟動的 server。`
        : `無法連接 llama.cpp server（${targetLabel}）：${detail}`
      // 用 400 而非 5xx：Anthropic SDK 對 5xx 會自動重試，但連線層失敗
      // 重試也沒意義（還是連不上），讓 SDK 立即把錯誤往上拋。
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: hint },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!openaiRes.ok) {
      const errText = await openaiRes.text()
      // M-LLAMACPP-CTX: 偵測 llama.cpp 的上下文溢出錯誤訊息（不同版本措辭不一）
      // 若命中則改寫成 Anthropic 的 "Prompt is too long" 格式，讓
      // src/services/api/errors.ts:isPromptTooLongMessage 能識別，
      // 觸發 reactive compaction 自動復原而非卡住。
      const isContextOverflow =
        openaiRes.status === 400 &&
        /(context|n_ctx|prompt|token)[^a-z]*(length|exceed|too (long|large|many)|out of)/i.test(
          errText,
        )
      const message = isContextOverflow
        ? `Prompt is too long (llama.cpp): ${errText}`
        : `llama.cpp error (${openaiRes.status}): ${errText}`
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: isContextOverflow ? 'invalid_request_error' : 'api_error',
            message,
          },
        }),
        {
          status: isContextOverflow ? 400 : openaiRes.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    if (openaiBody.stream) {
      if (!openaiRes.body) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'llama.cpp 回應缺少 body' },
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const hasTools =
        Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0
      // 有 tools 時走 retry wrapper：第一輪完整 buffer 後偵測空 tool_use 情境，
      // 命中就追加 nudge 重發一次。失去漸進輸出 UX 換 correctness。
      const sseGen = hasTools
        ? streamWithRetryOnEmptyTool(
            openaiRes.body,
            endpoint,
            openaiBody,
            reportedModel,
            effectiveApiKey,
          )
        : translateOpenAIStreamToAnthropic(
            openaiRes.body,
            reportedModel,
            mkMsgId(),
          )
      return new Response(sseGeneratorToStream(sseGen), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    const openaiJson = (await openaiRes.json()) as OpenAIChatCompletion
    const anthropicJson = translateChatCompletionToAnthropic(
      openaiJson,
      reportedModel,
    )

    return new Response(JSON.stringify(anthropicJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
