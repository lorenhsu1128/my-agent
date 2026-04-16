/**
 * 直接測試 llama-server 回傳含中文 tool_call arguments 的 SSE 串流
 * 的 raw bytes，不經過 adapter 翻譯，看看 bytes 是否正確。
 *
 * 需要 llama-server 跑在 http://127.0.0.1:8080
 *
 * Usage: bun run scripts/poc/llama-raw-bytes-test.ts
 */

const BASE_URL = process.env.LLAMA_BASE_URL ?? 'http://127.0.0.1:8080'

const tools = [
  {
    type: 'function',
    function: {
      name: 'SessionSearch',
      description: 'Search past sessions',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'keyword to search' },
          limit: { type: 'number', description: 'max results' },
        },
        required: ['query'],
      },
    },
  },
]

const body = {
  model: 'qwen3.5-9b-neo',
  messages: [
    {
      role: 'user',
      content:
        '請呼叫 SessionSearch 工具搜尋「天氣預報」（query 要用中文「天氣預報」，不要用英文）',
    },
  ],
  tools,
  tool_choice: { type: 'function', function: { name: 'SessionSearch' } },
  max_tokens: 512,
  stream: true,
}

console.log(`POST ${BASE_URL}/v1/chat/completions (stream=true)`)
console.log()

try {
  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    console.log(`HTTP ${resp.status}: ${await resp.text()}`)
    process.exit(1)
  }

  const reader = resp.body!.getReader()
  let chunkIdx = 0
  const allBytes: number[] = []
  const allText: string[] = []

  console.log('=== Raw chunks from llama-server ===')
  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    const bytes = Buffer.from(value)
    allBytes.push(...bytes)

    // 看看有沒有 arguments 的 bytes
    const hex = bytes.toString('hex')
    const hasArgs = hex.includes(
      Buffer.from('arguments').toString('hex'),
    )
    const text = bytes.toString('utf-8')
    allText.push(text)

    if (hasArgs || text.includes('argument')) {
      console.log(
        `chunk[${chunkIdx}] ${bytes.length} bytes (含 arguments):`,
      )
      console.log(`  hex: ${hex}`)
      console.log(`  utf8: ${text.replace(/\n/g, '\\n')}`)
    }
    chunkIdx++
  }

  console.log(`\n總共 ${chunkIdx} chunks, ${allBytes.length} bytes`)

  // 合併所有 text，找到 arguments 的值
  const fullText = allText.join('')
  console.log('\n=== 完整回應（截取 tool_calls 部分）===')

  // 從 SSE lines 找所有 data: 行，parse，看 arguments
  const lines = fullText.split('\n')
  let accArgs = ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      const tc =
        obj.choices?.[0]?.delta?.tool_calls?.[0]
      if (tc?.function?.arguments) {
        accArgs += tc.function.arguments
        console.log(
          `  arguments chunk: "${tc.function.arguments}" (hex: ${Buffer.from(tc.function.arguments).toString('hex')})`,
        )
      }
      if (tc?.function?.name) {
        console.log(`  tool name: "${tc.function.name}"`)
      }
    } catch {
      // 非 JSON 行
    }
  }

  console.log(`\n=== 累積的 arguments ===`)
  console.log(`  raw: "${accArgs}"`)
  console.log(`  hex: ${Buffer.from(accArgs).toString('hex')}`)

  // 驗證
  const expected = '天氣預報'
  const expectedHex = Buffer.from(expected).toString('hex')
  console.log(`\n  期望: "${expected}" (hex: ${expectedHex})`)

  if (accArgs.includes(expected)) {
    console.log(`  ✓ 含正確中文「天氣預報」`)
  } else {
    console.log(`  ✗ 不含「天氣預報」— llama-server 或 Bun fetch 有問題`)
    // 找 hex 差異
    console.log(`\n  === 逐 byte 比對 ===`)
    const accBuf = Buffer.from(accArgs)
    const expBuf = Buffer.from(expected)
    console.log(`  actual bytes:   ${accBuf.toString('hex')}`)
    console.log(`  expected bytes: ${expBuf.toString('hex')}`)
  }
} catch (err) {
  console.error('fetch 失敗:', (err as Error).message)
  console.error('請確認 llama-server 跑在', BASE_URL)
}
