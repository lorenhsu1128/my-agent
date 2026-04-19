#!/usr/bin/env bun
/**
 * M-VISION E2E — 對實際 llama-server 丟圖驗證視覺識別。
 *
 * Opt-in：必須設 MYAGENT_VISION_E2E=1 才會跑。
 *
 * 前置：
 *   1. llama-server 以 vision 模型 + --mmproj 啟動（Gemopus-4-E4B-it 或同類）
 *   2. ~/.my-agent/llamacpp.json 的 vision.enabled = true
 *   3. LLAMA_BASE_URL 正確指向 llama-server（或用預設 127.0.0.1:8080）
 *
 * 用法：
 *   MYAGENT_VISION_E2E=1 bun run tests/integration/llamacpp/vision-e2e.ts
 *
 * 驗證：
 *   - 產一張 1x1 紅色 PNG（base64 inline，不碰檔案系統）
 *   - 透過 adapter 的 translate 路徑組 OpenAI 請求，直接打到 llama-server
 *   - 讀回應文字，斷言包含「red」或「紅」
 */
import { translateMessagesToOpenAI } from '../../../src/services/api/llamacpp-fetch-adapter.js'

if (process.env.MYAGENT_VISION_E2E !== '1') {
  console.log(
    'MYAGENT_VISION_E2E != 1 → 跳過 E2E（設 MYAGENT_VISION_E2E=1 並確保 vision llama-server 啟動後再跑）',
  )
  process.exit(0)
}

const baseUrl = process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080/v1'
const model = process.env.LLAMA_MODEL || 'gemopus-4-e4b'

// 1x1 純紅 PNG（用 bun 產）
function tinyRedPngBase64(): string {
  // 預先算好的最小 1x1 PNG（純紅 FF0000FF），14 byte IDAT 壓縮；
  // 這個 base64 是合法的 PNG 檔案，能被任何圖像解碼器讀。
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
}

async function main(): Promise<void> {
  const b64 = tinyRedPngBase64()

  // 用 translate helper 確認 vision:true 產出格式正確，再直接打 llama-server
  const openaiMessages = translateMessagesToOpenAI(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'What is the dominant color of this image? Reply with a single word only.',
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: b64 },
          },
        ],
      },
    ],
    { vision: true },
  )

  const body = {
    model,
    messages: [{ role: 'system', content: 'You are a helpful vision assistant.' }, ...openaiMessages],
    max_tokens: 64,
    stream: false,
  }

  console.log(`→ POST ${baseUrl}/chat/completions (model=${model})`)

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => '<no body>')
    console.error(`✗ HTTP ${res.status}: ${txt.slice(0, 500)}`)
    process.exit(1)
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const reply = json.choices?.[0]?.message?.content ?? ''
  console.log(`← reply: ${reply}`)

  const lower = reply.toLowerCase()
  if (lower.includes('red') || reply.includes('紅')) {
    console.log('✓ model identified color as red')
    process.exit(0)
  } else {
    console.error(`✗ expected "red" / "紅" in reply; got: ${reply}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('E2E error:', e)
  process.exit(1)
})
