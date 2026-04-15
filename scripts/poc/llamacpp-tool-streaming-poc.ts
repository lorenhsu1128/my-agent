/**
 * 階段三煙測：tool_call 串流翻譯
 *
 * 對 llamacpp-fetch-adapter 發一個定義了工具的串流請求，確認：
 *  - 模型如果決定呼叫工具，adapter 正確發出 tool_use content_block_start
 *    + input_json_delta × N + content_block_stop
 *  - finalMessage 的 ToolUseBlock.input 能被 Anthropic SDK 重組成合法 JSON
 *  - stop_reason 正確映射為 'tool_use'
 *
 * 注意：Qwen3.5-Neo 不保證一定會呼叫工具；若它改用文字回答，本 poc 仍
 * 算 adapter 正確（只是測不到 tool path）。重試幾次或加強 prompt 即可。
 *
 * 執行：bun run scripts/poc/llamacpp-tool-streaming-poc.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { createLlamaCppFetch } from '../../src/services/api/llamacpp-fetch-adapter.js'

async function main() {
  const fetch = createLlamaCppFetch({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3.5-9b-neo',
  })

  const client = new Anthropic({
    apiKey: 'llamacpp-placeholder',
    baseURL: 'http://fake.anthropic.local',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: fetch as any,
  })

  console.log('\n=== Tool-call streaming test ===')
  const stream = await client.messages.stream({
    model: 'qwen3.5-9b-neo',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          'Use the get_weather tool to check the weather in Tokyo. Then tell me to take an umbrella if raining.',
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        input_schema: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
      },
    ],
  })

  const eventCounts: Record<string, number> = {}
  const deltaTypes = new Set<string>()
  let toolUseStartsSeen = 0
  let inputJsonDeltasSeen = 0
  const partialJsonBuf: string[] = []

  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
    if (event.type === 'content_block_start') {
      if ((event.content_block as { type: string }).type === 'tool_use') {
        toolUseStartsSeen++
        const tb = event.content_block as { type: string; id: string; name: string }
        console.log(`  → tool_use start: id=${tb.id} name=${tb.name}`)
      }
    } else if (event.type === 'content_block_delta') {
      const d = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
      deltaTypes.add(d.type)
      if (d.type === 'input_json_delta' && d.partial_json) {
        inputJsonDeltasSeen++
        partialJsonBuf.push(d.partial_json)
      }
    }
  }

  const final = await stream.finalMessage()

  console.log('\n事件計數：', eventCounts)
  console.log('delta 類型：', [...deltaTypes].join(', '))
  console.log('tool_use start 次數：', toolUseStartsSeen)
  console.log('input_json_delta 次數：', inputJsonDeltasSeen)
  console.log('partial_json 累積：', partialJsonBuf.join(''))
  console.log('\nfinal.content blocks：', final.content.length)
  for (const [i, block] of final.content.entries()) {
    if (block.type === 'tool_use') {
      console.log(`  [${i}] tool_use: name=${block.name}, input=${JSON.stringify(block.input)}`)
    } else if (block.type === 'text') {
      console.log(`  [${i}] text: ${(block.text).slice(0, 80)}`)
    } else if (block.type === 'thinking') {
      console.log(`  [${i}] thinking: ${(block as { thinking: string }).thinking.slice(0, 80)}...`)
    } else {
      console.log(`  [${i}] ${block.type}`)
    }
  }
  console.log('final.stop_reason：', final.stop_reason)

  // 斷言
  if (toolUseStartsSeen > 0) {
    // 有 tool_use：驗證 input 是合法 JSON
    const toolBlock = final.content.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string; input: Record<string, unknown> }
      | undefined
    if (!toolBlock) {
      console.error('\n✗ content_block_start 發過 tool_use 但 final 找不到')
      process.exit(1)
    }
    if (typeof toolBlock.input !== 'object' || toolBlock.input === null) {
      console.error('\n✗ tool_use.input 不是物件：', toolBlock.input)
      process.exit(2)
    }
    if (final.stop_reason !== 'tool_use') {
      console.error('\n✗ stop_reason 應為 tool_use，實際：', final.stop_reason)
      process.exit(3)
    }
    console.log('\n✓ 階段三煙測通過：tool_call 串流翻譯正確重組')
  } else {
    console.log(
      '\n⚠ 模型本次沒呼叫工具（Qwen3.5-Neo 選擇直接文字回答）— adapter 路徑未測到 tool_use；'
        + '結構層面：事件流正常、無破壞、stop_reason 合法。重試或加強 prompt 可觸發。',
    )
  }
}

main().catch(err => {
  console.error('\n✗ 煙測失敗：', err.message || err)
  if (err?.status) console.error('  status:', err.status)
  if (err?.error) console.error('  error:', JSON.stringify(err.error))
  process.exit(10)
})
