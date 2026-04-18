/**
 * PoC：路徑 B（fetch adapter）可行性驗證
 *
 * 問題：Anthropic SDK 能否透過 fetch adapter 與 llama.cpp（OpenAI 相容）通訊，
 *       回傳形狀正常的 BetaMessage？
 *
 * 方法：
 *   1. 攔截 SDK 打到 /v1/messages 的請求，解析 Anthropic 格式
 *   2. 翻譯為 OpenAI chat completion 格式，POST 到 llama.cpp
 *   3. 把 OpenAI 回應重組為 Anthropic 形狀 JSON，包成 Response 回給 SDK
 *
 * 範圍限制（PoC，非正式產品）：
 *   - 只測 non-streaming（stream: false）
 *   - 不處理 tools / reasoning_content / multi-turn
 *   - 純文字 in → 純文字 out
 *
 * 執行：bun run scripts/poc/llamacpp-fetch-poc.ts
 */

import Anthropic from 'my-agent-ai/sdk'

const LLAMA_BASE = 'http://127.0.0.1:8080/v1'

// ── 翻譯：Anthropic request → OpenAI request ───────────────────────────────
function anthropicToOpenAIBody(a: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []

  // system prompt
  if (typeof a.system === 'string' && a.system) {
    messages.push({ role: 'system', content: a.system })
  } else if (Array.isArray(a.system)) {
    const sys = (a.system as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n')
    if (sys) messages.push({ role: 'system', content: sys })
  }

  // user/assistant messages
  for (const m of (a.messages as Array<{ role: string; content: unknown }>) ?? []) {
    let content = ''
    if (typeof m.content === 'string') content = m.content
    else if (Array.isArray(m.content)) {
      content = (m.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    }
    messages.push({ role: m.role, content })
  }

  return {
    model: 'qwen3.5-9b-neo',
    messages,
    max_tokens: (a.max_tokens as number) ?? 512,
    temperature: (a.temperature as number) ?? 0.1,
    stream: false,
  }
}

// ── 翻譯：OpenAI response → Anthropic response ─────────────────────────────
function openAIToAnthropicBody(o: {
  id: string
  model: string
  choices: Array<{
    message: { content: string; reasoning_content?: string }
    finish_reason: string
  }>
  usage: { prompt_tokens: number; completion_tokens: number }
}): Record<string, unknown> {
  const choice = o.choices[0]
  const content: Array<{ type: string; text?: string; thinking?: string }> = []

  // ADR-006：reasoning_content → thinking block
  if (choice.message.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content })
  }
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  const finishMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  }

  return {
    id: o.id,
    type: 'message',
    role: 'assistant',
    model: o.model,
    content,
    stop_reason: finishMap[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: o.usage.prompt_tokens,
      output_tokens: o.usage.completion_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

// ── fetch adapter ───────────────────────────────────────────────────────────
const llamaFetch: typeof globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)

  if (!url.includes('/v1/messages')) {
    return globalThis.fetch(input, init)
  }

  const bodyText =
    init?.body instanceof ReadableStream
      ? await new Response(init.body).text()
      : typeof init?.body === 'string'
        ? init.body
        : '{}'
  const anthropicBody = JSON.parse(bodyText)

  console.error(`[poc] anthropic → openai (model=${anthropicBody.model}, msgs=${anthropicBody.messages?.length})`)

  const openaiBody = anthropicToOpenAIBody(anthropicBody)
  const openaiRes = await globalThis.fetch(`${LLAMA_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(openaiBody),
  })

  if (!openaiRes.ok) {
    const err = await openaiRes.text()
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `llama.cpp error (${openaiRes.status}): ${err}` },
      }),
      { status: openaiRes.status, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const openaiJson = await openaiRes.json() as Parameters<typeof openAIToAnthropicBody>[0]
  console.error(`[poc] openai finish=${openaiJson.choices[0].finish_reason} tokens=${openaiJson.usage.completion_tokens}`)
  const anthropicJson = openAIToAnthropicBody(openaiJson)

  return new Response(JSON.stringify(anthropicJson), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── 測試 ────────────────────────────────────────────────────────────────────
async function main() {
  const client = new Anthropic({
    apiKey: 'llamacpp-placeholder',
    baseURL: 'http://127.0.0.1:8080/fake-anthropic',  // 走 /v1/messages 但這 host 永遠不會被真實打到
    fetch: llamaFetch,
  })

  console.log('\n=== Test 1: 非串流，簡單文字 ===')
  const msg = await client.messages.create({
    model: 'qwen3.5-9b-neo',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'What is 2+2? Reply in one sentence.' }],
  })

  console.log('response.id:', msg.id)
  console.log('response.stop_reason:', msg.stop_reason)
  console.log('response.usage:', JSON.stringify(msg.usage))
  console.log('response.content blocks:', msg.content.length)
  for (const block of msg.content) {
    if (block.type === 'text') {
      console.log('  [text]', block.text)
    } else if (block.type === 'thinking') {
      console.log('  [thinking]', (block as { thinking: string }).thinking.slice(0, 100), '...')
    } else {
      console.log('  [unknown]', block.type, JSON.stringify(block).slice(0, 150))
    }
  }

  // 檢查 SDK 是否正確解析
  if (msg.role === 'assistant' && msg.type === 'message' && msg.content.length > 0) {
    console.log('\n✓ PoC 通過：Anthropic SDK 成功解析翻譯後的回應')
  } else {
    console.log('\n✗ PoC 失敗：SDK 回傳 shape 不正常')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n✗ PoC 失敗:', err.message)
  if (err.status) console.error('  status:', err.status)
  if (err.error) console.error('  error:', JSON.stringify(err.error))
  process.exit(1)
})
