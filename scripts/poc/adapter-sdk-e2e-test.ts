/**
 * 端到端測試：adapter → Anthropic SDK → 最終 tool_use input。
 * 不經 TUI / tool framework，只測「SDK 是否正確累積 input_json_delta」。
 *
 * 需要 llama-server 跑在 http://127.0.0.1:8080
 *
 * Usage: bun run scripts/poc/adapter-sdk-e2e-test.ts
 */
import Anthropic from 'my-agent-ai/sdk'
import { createLlamaCppFetch } from '../../src/services/api/llamacpp-fetch-adapter.js'

const config = {
  baseUrl: process.env.LLAMA_BASE_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLAMA_MODEL ?? 'qwen3.5-9b-neo',
}

console.log(`config: ${JSON.stringify(config)}`)
console.log()

const customFetch = createLlamaCppFetch(config)
const client = new Anthropic({ apiKey: 'not-needed', fetch: customFetch })

const tools: Anthropic.Messages.Tool[] = [
  {
    name: 'SessionSearch',
    description: 'Search past sessions by keyword',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'keyword' },
        limit: { type: 'number', description: 'max results' },
      },
      required: ['query'],
    },
  },
]

// ============================
// Test 1: Non-streaming
// ============================
console.log('=== Test 1: Non-streaming messages.create ===')
try {
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    tools,
    tool_choice: { type: 'tool', name: 'SessionSearch' },
    messages: [
      {
        role: 'user',
        content: '搜尋「天氣預報」',
      },
    ],
  })

  console.log('stop_reason:', resp.stop_reason)
  for (const block of resp.content) {
    if (block.type === 'tool_use') {
      console.log('tool_use.name:', block.name)
      console.log('tool_use.input:', JSON.stringify(block.input))
      console.log('tool_use.input type:', typeof block.input)
      console.log(
        'input.query:',
        (block.input as { query?: unknown }).query,
        typeof (block.input as { query?: unknown }).query,
      )
      if (
        typeof (block.input as { query?: string }).query === 'string' &&
        (block.input as { query?: string }).query!.includes('天氣')
      ) {
        console.log('✓ Non-streaming: 中文 query 正確')
      } else {
        console.log('✗ Non-streaming: 中文 query 遺失或亂碼')
      }
    }
  }
} catch (err) {
  console.error('Non-streaming 失敗:', (err as Error).message)
}

// ============================
// Test 2: Raw stream (.create with stream: true) — 跟 claude.ts 一模一樣的路徑
// ============================
console.log('\n=== Test 2: Raw stream (claude.ts 路徑) ===')
try {
  const rawStream = await client.beta.messages.create(
    {
      model: config.model,
      max_tokens: 512,
      tools: tools as Anthropic.Beta.Messages.BetaToolUnion[],
      tool_choice: { type: 'tool', name: 'SessionSearch' } as Anthropic.Beta.Messages.BetaToolChoice,
      messages: [
        { role: 'user', content: '搜尋「天氣預報」' },
      ],
      stream: true,
      betas: [],
    },
  )

  // 模擬 claude.ts 的累積邏輯
  const contentBlocks: Record<number, { type: string; input: string; name?: string }> = {}

  for await (const part of rawStream) {
    switch (part.type) {
      case 'content_block_start':
        if (part.content_block.type === 'tool_use') {
          contentBlocks[part.index] = {
            ...part.content_block,
            input: '',  // 跟 claude.ts L2000 一樣
          }
          console.log(`  [content_block_start] index=${part.index} name=${part.content_block.name} input='' (覆寫)`)
        }
        break
      case 'content_block_delta':
        if (part.delta.type === 'input_json_delta') {
          const cb = contentBlocks[part.index]
          if (cb && typeof cb.input === 'string') {
            cb.input += part.delta.partial_json
            console.log(`  [input_json_delta] index=${part.index} partial="${part.delta.partial_json}" accumulated_len=${cb.input.length}`)
          } else {
            console.log(`  [input_json_delta] index=${part.index} ⚠️ contentBlock missing or input not string`)
          }
        }
        break
      case 'content_block_stop': {
        const cb = contentBlocks[part.index]
        if (cb) {
          console.log(`  [content_block_stop] index=${part.index} accumulated input="${cb.input}"`)
          // JSON.parse 就像 normalizeContentFromAPI 做的
          try {
            const parsed = JSON.parse(cb.input)
            console.log(`  parsed: ${JSON.stringify(parsed)}`)
            const q = (parsed as { query?: string }).query
            if (typeof q === 'string' && q.includes('天氣')) {
              console.log(`  ✓ Raw stream: 中文 query 正確「${q}」`)
            } else {
              console.log(`  ✗ Raw stream: 中文 query 遺失`)
              console.log(`  parsed keys: ${Object.keys(parsed)}`)
            }
          } catch (e) {
            console.log(`  ✗ JSON.parse 失敗: ${(e as Error).message}`)
            console.log(`  raw input string (first 200 chars): ${cb.input.slice(0, 200)}`)
            console.log(`  raw input hex: ${Buffer.from(cb.input).toString('hex').slice(0, 200)}`)
          }
        }
        break
      }
    }
  }
} catch (err) {
  console.error('Raw stream 失敗:', (err as Error).message)
}

// ============================
// Test 3: BetaMessageStream (.stream()) — 作為對照
// ============================
console.log('\n=== Test 3: BetaMessageStream (.stream()) 對照 ===')
try {
  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 512,
    tools,
    tool_choice: { type: 'tool', name: 'SessionSearch' },
    messages: [
      { role: 'user', content: '搜尋「天氣預報」' },
    ],
  })

  const finalMessage = await stream.finalMessage()
  for (const block of finalMessage.content) {
    if (block.type === 'tool_use') {
      const q = (block.input as { query?: string }).query
      if (typeof q === 'string' && q.includes('天氣')) {
        console.log(`  ✓ BetaMessageStream: 中文 query 正確「${q}」`)
      } else {
        console.log(`  ✗ BetaMessageStream: 中文 query 遺失`)
        console.log(`  input: ${JSON.stringify(block.input)}`)
      }
    }
  }
} catch (err) {
  console.error('BetaMessageStream 失敗:', (err as Error).message)
}
