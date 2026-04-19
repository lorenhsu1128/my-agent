#!/usr/bin/env bun
/**
 * M-VISION 文字模型回歸 smoke — 確認純文字模型收到 image block 時，
 * adapter 產生 `[Image attachment]` 字串佔位符路徑。
 *
 * 用法：bun run tests/integration/llamacpp/text-model-fallback-smoke.ts
 *
 * 這是 adapter 層面的驗證，不需要 llama-server 跑著。
 * 模擬 vision.enabled=false（或未設定）情境。
 */
import { translateMessagesToOpenAI } from '../../../src/services/api/llamacpp-fetch-adapter.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

console.log('— 模擬 Qwen3.5-Neo（純文字）收到含 image block 的訊息')

// 情境 1：options 完全不傳（預設）
{
  const out = translateMessagesToOpenAI([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
        },
      ],
    },
  ])
  assert(
    typeof out[0].content === 'string',
    '預設（未傳 options）→ content 仍為 string',
  )
  assert(
    (out[0].content as string).includes('[Image attachment]'),
    '預設 → image 轉 [Image attachment] 佔位符',
  )
}

// 情境 2：明確傳 vision:false
{
  const out = translateMessagesToOpenAI(
    [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'B' },
          },
        ],
      },
    ],
    { vision: false },
  )
  assert(
    typeof out[0].content === 'string',
    'vision:false → content 仍為 string',
  )
  assert(
    (out[0].content as string) === '[Image attachment]',
    'vision:false 單 image block → 只有佔位符字串',
  )
}

// 情境 3：tool_result + image 混合（不該影響 tool 處理）
{
  const out = translateMessagesToOpenAI(
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_123',
            content: 'file contents',
          },
          { type: 'text', text: 'and look at this' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://x/y.png' },
          },
        ],
      },
    ],
    { vision: false },
  )
  // 應該有 2 條 message：tool + user
  assert(out.length === 2, '產生 2 條 OpenAI messages（tool + user）')
  assert(out[0].role === 'tool', '第一條是 tool')
  assert(out[0].tool_call_id === 'tu_123', 'tool_call_id 正確映射')
  assert(out[1].role === 'user', '第二條是 user')
  assert(
    typeof out[1].content === 'string' &&
      (out[1].content as string).includes('[Image attachment]'),
    'user content 含佔位符',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
