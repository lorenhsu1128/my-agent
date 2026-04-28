/**
 * sideQuery 在 llama.cpp 模式下的直通實作。
 *
 * 背景：sideQuery() 原走 getAnthropicClient()（在 llamacpp 時其實也會經
 * adapter 翻譯）。但 adapter 路徑為主查詢設計，會連帶帶入：
 *   - fingerprint 計算、CLI attribution header（OAuth 用，本地無意義）
 *   - CLI system prompt 前綴、metadata header（llamacpp 忽略但污染 prompt）
 *   - output_format（結構化輸出 beta）— llamacpp 不支援，adapter 目前靜默忽略
 *
 * 這個 helper 直接打 `${baseUrl}/chat/completions`，翻譯成 Anthropic
 * `BetaMessage`-shape 回傳，讓 sideQuery 的 5 個 caller 解析邏輯零修改。
 * output_format 會被降級為純 prompt engineering（仍送系統 + 使用者訊息，
 * 結果交給 caller 自行 parse）。
 */
import type Anthropic from 'my-agent-ai/sdk'
import type { BetaToolUnion } from 'my-agent-ai/sdk/resources/beta/messages'
import { logForDebugging } from '../../utils/debug.js'
import type { SideQueryOptions } from '../../utils/sideQuery.js'

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock
type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool

type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool'

type OpenAIMessage = {
  role: OpenAIRole
  content?: string | null
  name?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type OpenAIRequestBody = {
  model: string
  messages: OpenAIMessage[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  stop?: string[]
  tools?: OpenAIToolDef[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
}

type OpenAIChatCompletion = {
  id?: string
  choices: Array<{
    finish_reason: string
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
      reasoning_content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

const FINISH_TO_STOP: Record<string, BetaMessage['stop_reason']> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

function flattenSystem(system: SideQueryOptions['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

function messageContentToText(content: MessageParam['content']): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image attached]')
    else if (block.type === 'tool_result') {
      const c = (block as { content?: unknown }).content
      if (typeof c === 'string') parts.push(c)
      else if (Array.isArray(c)) {
        for (const sub of c) {
          const s = sub as { type?: string; text?: string }
          if (s.type === 'text' && typeof s.text === 'string') parts.push(s.text)
        }
      }
    }
  }
  return parts.join('\n')
}

function translateMessages(messages: MessageParam[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // tool_result 需展開為獨立 'tool' 角色訊息
      if (Array.isArray(m.content)) {
        const toolResults: OpenAIMessage[] = []
        const textParts: string[] = []
        for (const block of m.content) {
          if (block.type === 'tool_result') {
            const c = (block as { content?: unknown; tool_use_id: string }).content
            let text = ''
            if (typeof c === 'string') text = c
            else if (Array.isArray(c)) {
              text = c
                .map(s => {
                  const sb = s as { type?: string; text?: string }
                  return sb.type === 'text' ? sb.text ?? '' : ''
                })
                .join('\n')
            }
            toolResults.push({
              role: 'tool',
              tool_call_id: (block as { tool_use_id: string }).tool_use_id,
              content: text,
            })
          } else if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'image') {
            textParts.push('[image attached]')
          }
        }
        if (toolResults.length > 0) {
          out.push(...toolResults)
          if (textParts.length > 0) {
            out.push({ role: 'user', content: textParts.join('\n') })
          }
        } else {
          out.push({ role: 'user', content: textParts.join('\n') })
        }
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
      const textParts: string[] = []
      if (typeof m.content === 'string') {
        textParts.push(m.content)
      } else {
        for (const block of m.content) {
          if (block.type === 'text') textParts.push(block.text)
          else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
          }
        }
      }
      const msg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      out.push(msg)
    }
  }
  return out
}

function translateTools(
  tools: SideQueryOptions['tools'],
): OpenAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: OpenAIToolDef[] = []
  for (const t of tools) {
    const tool = t as Tool | BetaToolUnion
    const name = (tool as { name?: string }).name
    if (!name) continue
    const description = (tool as { description?: string }).description
    const parameters = (tool as { input_schema?: Record<string, unknown> })
      .input_schema
    out.push({
      type: 'function',
      function: {
        name,
        ...(description && { description }),
        ...(parameters && { parameters }),
      },
    })
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(
  toolChoice: SideQueryOptions['tool_choice'],
): OpenAIRequestBody['tool_choice'] | undefined {
  if (!toolChoice) return undefined
  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'any') return 'auto'
  if (toolChoice.type === 'none') return 'none'
  if (toolChoice.type === 'tool') {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return undefined
}

function mkMsgId(): string {
  return `msg_llamacpp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/**
 * 在 llama.cpp 模式下執行 sideQuery。回傳 BetaMessage-shape 讓既有 caller
 * 解析邏輯零修改。output_format 被降級為純 prompt（若模型不輸出合法 JSON
 * caller 的 catch 會接住）。
 */
export async function sideQueryViaLlamaCpp(
  opts: SideQueryOptions,
): Promise<BetaMessage> {
  // M-LLAMACPP-REMOTE: 走 routing.sideQuery（缺欄位 = 'local'）
  const { resolveEndpoint } = await import('../../llamacppConfig/index.js')
  const ep = resolveEndpoint('sideQuery')
  const systemText = flattenSystem(opts.system)
  const openaiMessages: OpenAIMessage[] = []
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText })
  }
  openaiMessages.push(...translateMessages(opts.messages))

  if (opts.output_format) {
    logForDebugging(
      '[llamacppSideQuery] output_format ignored (llama.cpp 不支援 structured outputs beta)；降級為純 prompt',
      { level: 'warn' },
    )
  }

  const body: OpenAIRequestBody = {
    model: ep.model,
    messages: openaiMessages,
    max_tokens: opts.max_tokens ?? 1024,
    stream: false,
    ...(typeof opts.temperature === 'number' && { temperature: opts.temperature }),
    ...(opts.stop_sequences &&
      opts.stop_sequences.length > 0 && { stop: opts.stop_sequences }),
  }
  const tools = translateTools(opts.tools)
  if (tools) body.tools = tools
  const toolChoice = translateToolChoice(opts.tool_choice)
  if (toolChoice) body.tool_choice = toolChoice

  const endpoint = `${ep.baseUrl.replace(/\/$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `llama.cpp sideQuery HTTP ${res.status}: ${text.slice(0, 500)}`,
    )
  }
  const json = (await res.json()) as OpenAIChatCompletion
  const choice = json.choices?.[0]
  if (!choice) {
    throw new Error('llama.cpp sideQuery: 回應缺少 choices[0]')
  }

  const content: BetaContentBlock[] = []
  const reasoning = choice.message.reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' })
  }
  const toolCalls = choice.message.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      let parsedInput: unknown = {}
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
  const text = choice.message.content
  if (typeof text === 'string' && text.length > 0) {
    content.push({ type: 'text', text, citations: null })
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '', citations: null })
  }

  const stopReason = FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn'

  const message: BetaMessage = {
    id: json.id || mkMsgId(),
    type: 'message',
    role: 'assistant',
    model: ep.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:
        json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  }
  return message
}
