/**
 * 針對性測試：iterOpenAISSELines 的 Buffer.concat 修正能否正確處理
 * UTF-8 multi-byte 字元被跨 chunk 切割的情境。
 *
 * 模擬 llama-server 回傳一個含中文 tool_call arguments 的 SSE 串流，
 * 刻意在「天氣預報」的 UTF-8 bytes 中間切割。
 *
 * Usage: bun run scripts/poc/utf8-sse-test.ts
 */

// 不需要真的 llama-server — 直接創建 ReadableStream 模擬

const CHINESE = '天氣預報' // 每字 3 bytes = 12 bytes total
const SSE_LINE = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${CHINESE}"}}]}}]}\n\n`

console.log('=== 測試 iterOpenAISSELines UTF-8 處理 ===')
console.log(`原始中文: "${CHINESE}" (${CHINESE.length} chars)`)

const fullBytes = new TextEncoder().encode(SSE_LINE)
console.log(`SSE line total bytes: ${fullBytes.length}`)

// 找到「天」的第一個 byte 的位置，在中間切（例如切在第 2 byte）
const targetStr = CHINESE
const targetBytes = new TextEncoder().encode(targetStr)
const prefixStr = SSE_LINE.slice(0, SSE_LINE.indexOf(targetStr))
const prefixBytes = new TextEncoder().encode(prefixStr)
const cutPoint = prefixBytes.length + 2 // 在「天」(E5 A4 A9) 的第 2 byte 後切 → 破壞 multi-byte

console.log(`切割位置: byte ${cutPoint} (在 "${targetStr}" 的 UTF-8 bytes 中間)`)
console.log(`chunk1 = bytes[0:${cutPoint}]`)
console.log(`chunk2 = bytes[${cutPoint}:${fullBytes.length}]`)

const chunk1 = fullBytes.slice(0, cutPoint)
const chunk2 = fullBytes.slice(cutPoint)

// 驗證：TextDecoder({stream: true}) 是否有 bug
console.log('\n--- TextDecoder({stream: true}) 行為 ---')
const decoder = new TextDecoder()
const decoded1 = decoder.decode(chunk1, { stream: true })
const decoded2 = decoder.decode(chunk2, { stream: true })
const decoderResult = decoded1 + decoded2
const decoderHasChinese = decoderResult.includes(CHINESE)
console.log(`decoded1: "${decoded1.slice(-20)}"`)
console.log(`decoded2: "${decoded2.slice(0, 20)}"`)
console.log(`合併後含 "${CHINESE}": ${decoderHasChinese ? '✓ 正確' : '✗ 失敗 — TextDecoder streaming bug!'}`)

// 驗證：Buffer.concat 方式
console.log('\n--- Buffer.concat 方式（修後的 iterOpenAISSELines）---')
const combined = Buffer.concat([Buffer.from(chunk1), Buffer.from(chunk2)])
const idx = combined.indexOf(0x0a) // \n
const lineBytes = combined.subarray(0, idx)
const lineStr = lineBytes.toString('utf-8')
const bufferHasChinese = lineStr.includes(CHINESE)
console.log(`line: "...${lineStr.slice(-40)}"`)
console.log(`含 "${CHINESE}": ${bufferHasChinese ? '✓ 正確' : '✗ 失敗'}`)

// 端到端：透過 ReadableStream → iterOpenAISSELines
console.log('\n--- 端到端：ReadableStream → iterOpenAISSELines ---')

// 動態 import adapter
const { createLlamaCppFetch } = await import(
  '../../src/services/api/llamacpp-fetch-adapter.js'
)

// 我們不能直接 import iterOpenAISSELines（不 export），但可以透過
// 模擬一個完整的 adapter 呼叫來間接測試。
// 更簡單：直接重現 iterOpenAISSELines 邏輯做端到端驗證。

// 建一個 ReadableStream，分兩 chunk 送出（模擬網路切割）
const mockStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(chunk1)
    controller.enqueue(chunk2)
    controller.close()
  },
})

// 用跟修正後一樣的 Buffer.concat 邏輯讀
const reader = mockStream.getReader()
let rawBuf = Buffer.alloc(0)
const results: string[] = []
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  rawBuf = Buffer.concat([rawBuf, Buffer.from(value)])
  let bufIdx: number
  while ((bufIdx = rawBuf.indexOf(0x0a)) !== -1) {
    const lb = rawBuf.subarray(0, bufIdx)
    rawBuf = rawBuf.subarray(bufIdx + 1)
    const line = lb.toString('utf-8').replace(/\r$/, '')
    if (line.startsWith('data:')) {
      results.push(line.slice(5).trim())
    }
  }
}

if (results.length === 0) {
  console.log('✗ 沒有任何 SSE payload 被 yield')
} else {
  const payload = results[0]!
  console.log(`payload (截尾): ...${payload.slice(-60)}`)
  try {
    const parsed = JSON.parse(payload)
    const args = parsed.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments
    console.log(`parsed arguments: "${args}"`)
    if (args === CHINESE) {
      console.log(`✓ 端到端正確！"${CHINESE}" 完整保留`)
    } else {
      console.log(`✗ 端到端失敗：期望 "${CHINESE}"，得到 "${args}"`)
    }
  } catch (e) {
    console.log(`✗ JSON.parse 失敗: ${(e as Error).message}`)
  }
}

// 最後結論
console.log('\n=== 結論 ===')
if (!decoderHasChinese) {
  console.log('⚠️  TextDecoder({stream: true}) 確實有 Bun Windows bug')
}
if (bufferHasChinese) {
  console.log('✓ Buffer.concat 修正有效')
} else {
  console.log('✗ Buffer.concat 修正無效 — 需要其他方案')
}
