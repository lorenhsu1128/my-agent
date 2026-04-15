/**
 * LlamaCpp Fetch Adapter（路徑 B）
 *
 * 攔截 Anthropic SDK 打到 /v1/messages 的 fetch 呼叫，翻譯成 OpenAI Chat
 * Completions API 格式，轉發到本地 llama.cpp server，再把回應翻譯回
 * Anthropic Messages 形狀。SDK 與下游（QueryEngine、StreamingToolExecutor）
 * 完全無感，程式碼路徑維持 Anthropic schema。
 *
 * 設計決策（DEPLOYMENT_PLAN.md M1 階段二實作 plan / ADR-005 / ADR-006）：
 *  - 不 import @anthropic-ai/sdk 型別；inline 自定義 interface，邊界乾淨。
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

interface OpenAIMessage {
  role: string
  content: string | null
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
  if (typeof system === 'string') return system
  return system.map(b => b.text ?? '').filter(Boolean).join('\n')
}

// ── 請求翻譯：Anthropic → OpenAI ──────────────────────────────────────────

/**
 * 把 Anthropic messages 陣列轉成 OpenAI chat messages 陣列。
 * 本階段處理 text / tool_use / tool_result；image 視為 [Image] 佔位。
 */
function translateMessagesToOpenAI(
  anthropicMessages: AnthropicMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const textParts: string[] = []
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
          textParts.push('[Image attachment]')
        }
      }
      if (textParts.length > 0) {
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
 */
function translateRequestToOpenAI(
  anthropic: AnthropicRequestBody,
  defaultModel: string,
): OpenAIRequestBody {
  const systemPrompt = flattenSystemPrompt(anthropic.system)
  const messages: OpenAIMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push(...translateMessagesToOpenAI(anthropic.messages ?? []))

  const body: OpenAIRequestBody = {
    model: anthropic.model || defaultModel,
    messages,
    max_tokens: anthropic.max_tokens ?? 4096,
    stream: anthropic.stream === true,
  }
  if (typeof anthropic.temperature === 'number') body.temperature = anthropic.temperature
  if (typeof anthropic.top_p === 'number') body.top_p = anthropic.top_p
  const tools = translateToolsToOpenAI(anthropic.tools)
  if (tools) body.tools = tools
  return body
}

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
      cache_read_input_tokens: 0,
    },
  }
}

// ── 主 export：fetch 攔截器 ────────────────────────────────────────────────

export interface LlamaCppConfig {
  baseUrl: string
  model: string
}

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

    // 解析 Anthropic request body
    let anthropicBody: AnthropicRequestBody = {}
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText) as AnthropicRequestBody
    } catch {
      anthropicBody = {}
    }

    const openaiBody = translateRequestToOpenAI(anthropicBody, config.model)
    const endpoint = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`

    // 串流在 Step 2b 實作；本階段走 non-streaming 為主
    if (openaiBody.stream) {
      // TODO(階段二 Step 2b)：實作 translateOpenAIStreamToAnthropicSSE
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message:
              'llamacpp adapter streaming not yet implemented — will be added in Step 2b',
          },
        }),
        {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    // Non-streaming：完整翻譯
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const openaiRes = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiBody),
    })

    if (!openaiRes.ok) {
      const errText = await openaiRes.text()
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `llama.cpp error (${openaiRes.status}): ${errText}`,
          },
        }),
        {
          status: openaiRes.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const openaiJson = (await openaiRes.json()) as OpenAIChatCompletion
    const anthropicJson = translateChatCompletionToAnthropic(
      openaiJson,
      anthropicBody.model ?? config.model,
    )

    return new Response(JSON.stringify(anthropicJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
