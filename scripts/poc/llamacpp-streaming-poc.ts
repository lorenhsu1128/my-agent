/**
 * V3：路徑 B streaming 煙測
 *
 * 用 Anthropic SDK `messages.stream()` 對本地 llama-server 發串流請求，
 * 驗證 llamacpp-fetch-adapter.ts 的 SSE 翻譯器產出正確事件序列。
 *
 * 執行：
 *   bash scripts/llama/serve.sh  # 或確認已啟動
 *   bun run scripts/poc/llamacpp-streaming-poc.ts
 *
 * 預期事件序列（Qwen3.5-Neo 帶 CoT）：
 *   message_start
 *   content_block_start(thinking) → thinking_delta × N → content_block_stop
 *   content_block_start(text)     → text_delta × N     → content_block_stop
 *   message_delta (stop_reason=end_turn, usage)
 *   message_stop
 */

import Anthropic from 'my-agent-ai/sdk'
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

  console.log('\n=== V3 Streaming Test ===')
  const stream = await client.messages.stream({
    model: 'qwen3.5-9b-neo',
    max_tokens: 512,
    messages: [
      { role: 'user', content: 'What is 2+2? Reply with just the number.' },
    ],
  })

  const events: Record<string, number> = {}
  let textBuf = ''
  let thinkingBuf = ''
  const deltaTypes = new Set<string>()

  for await (const event of stream) {
    events[event.type] = (events[event.type] ?? 0) + 1
    if (event.type === 'content_block_delta') {
      const d = event.delta as { type: string; text?: string; thinking?: string }
      deltaTypes.add(d.type)
      if (d.type === 'text_delta' && d.text) textBuf += d.text
      if (d.type === 'thinking_delta' && d.thinking) thinkingBuf += d.thinking
    }
  }

  const final = await stream.finalMessage()

  console.log('事件計數：', events)
  console.log('delta 類型：', [...deltaTypes].join(', '))
  console.log('thinking (前 120 chars)：', thinkingBuf.slice(0, 120))
  console.log('text：', textBuf)
  console.log('final.content blocks：', final.content.length)
  for (const [i, block] of final.content.entries()) {
    console.log(`  [${i}] type=${block.type}`)
  }
  console.log('final.stop_reason：', final.stop_reason)
  console.log('final.usage：', JSON.stringify(final.usage))

  // 斷言
  const expected = [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]
  const missing = expected.filter(e => !events[e])
  if (missing.length > 0) {
    console.error('\n✗ 缺少事件類型：', missing)
    process.exit(1)
  }

  if (!/\d/.test(textBuf + thinkingBuf)) {
    console.error('\n✗ 回應中無數字（content+thinking 都沒 digit）')
    process.exit(2)
  }

  if (final.stop_reason !== 'end_turn') {
    console.error('\n✗ stop_reason 非 end_turn：', final.stop_reason)
    process.exit(3)
  }

  console.log('\n✓ V3 通過：streaming 事件序列與 finalMessage 符合 Anthropic 規範')
}

main().catch(err => {
  console.error('\n✗ V3 失敗：', err.message || err)
  if (err?.status) console.error('  status:', err.status)
  if (err?.error) console.error('  error:', JSON.stringify(err.error))
  process.exit(10)
})
