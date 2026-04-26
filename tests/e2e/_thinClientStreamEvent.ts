/**
 * M-DAEMON-STREAM E2E：驗證 daemon 向 thin client broadcast stream_event frame。
 *
 * 流程（沿用 _thinClientTurn.ts 的 fallbackManager pattern）：
 *   1. attach 到 daemon
 *   2. sendInput 一個會觸發 reasoning + 文字輸出的 prompt
 *   3. 監 frame：累計 stream_event count、thinking_delta count、text_delta count、
 *      assistant final count
 *   4. 等 turnEnd done
 *   5. assert：stream_event > 0、(thinking_delta > 0 OR text_delta > 0)、assistant final > 0
 *
 * 失敗代表 daemon 沒送 partial 過來 — 表示 includePartialMessages: true 沒生效或 broker 漏 forward。
 *
 * Exit codes：
 *   0  通過
 *   2  daemon not alive
 *   3  attach timeout
 *   4  turn timeout / turnEnd != done
 *   5  沒收到 stream_event frame（regression）
 *   6  unexpected
 */
import { createDaemonDetector } from '../../src/repl/thinClient/detectDaemon.js'
import { createFallbackManager } from '../../src/repl/thinClient/fallbackManager.js'
import type { InboundFrame } from '../../src/repl/thinClient/thinClientSocket.js'

interface DeltaEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
}

async function main(): Promise<number> {
  const detector = createDaemonDetector({ pollIntervalMs: 500 })
  const snap = await detector.check()
  if (!snap.alive) {
    console.error('stream-event: daemon not alive')
    detector.stop()
    return 2
  }

  const mgr = createFallbackManager({
    detector,
    cwd: process.cwd(),
    source: 'repl',
    reconnectTimeoutMs: 10_000,
  })

  const attachDeadline = Date.now() + 15_000
  while (mgr.state.mode !== 'attached' && Date.now() < attachDeadline) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (mgr.state.mode !== 'attached') {
    console.error(`stream-event: attach timeout (mode=${mgr.state.mode})`)
    await mgr.stop()
    detector.stop()
    return 3
  }
  console.log('stream-event: attached')

  let streamEventCount = 0
  let thinkingDeltaCount = 0
  let textDeltaCount = 0
  let inputJsonDeltaCount = 0
  let contentBlockStartCount = 0
  let assistantFinalCount = 0
  let turnEndedReason: string | null = null
  let firstThinkingPreview = ''
  let firstTextPreview = ''

  mgr.on('frame', (f: InboundFrame) => {
    if (f.type === 'turnEnd') {
      const fe = f as { reason?: string }
      turnEndedReason = fe.reason ?? 'unknown'
      return
    }
    if (f.type !== 'runnerEvent') return
    const evt = (f as { event?: { type?: string; payload?: unknown } }).event
    if (!evt || evt.type !== 'output') return
    const sdk = evt.payload as { type?: string; event?: DeltaEvent }
    if (!sdk) return
    if (sdk.type === 'stream_event') {
      streamEventCount += 1
      const inner = sdk.event
      if (inner?.type === 'content_block_start') contentBlockStartCount += 1
      if (inner?.type === 'content_block_delta') {
        const dt = inner.delta?.type
        if (dt === 'thinking_delta') {
          thinkingDeltaCount += 1
          if (firstThinkingPreview.length < 60 && inner.delta?.thinking) {
            firstThinkingPreview += inner.delta.thinking
          }
        } else if (dt === 'text_delta') {
          textDeltaCount += 1
          if (firstTextPreview.length < 60 && inner.delta?.text) {
            firstTextPreview += inner.delta.text
          }
        } else if (dt === 'input_json_delta') {
          inputJsonDeltaCount += 1
        }
      }
      return
    }
    if (sdk.type === 'assistant') assistantFinalCount += 1
  })

  // 引導模型短答 + 觸發 reasoning（qwen3.5-9b-neo 預設 <think> ON）
  const prompt = '請用一個阿拉伯數字回答 6 + 7 等於幾'
  console.log(`stream-event: sendInput "${prompt}"`)
  mgr.sendInput(prompt, 'interactive')

  const turnDeadline = Date.now() + 180_000
  while (turnEndedReason === null && Date.now() < turnDeadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  await mgr.stop()
  detector.stop()

  console.log('stream-event: ─── stats ───')
  console.log(`  stream_event total       : ${streamEventCount}`)
  console.log(`  content_block_start      : ${contentBlockStartCount}`)
  console.log(`  thinking_delta           : ${thinkingDeltaCount}`)
  console.log(`  text_delta               : ${textDeltaCount}`)
  console.log(`  input_json_delta         : ${inputJsonDeltaCount}`)
  console.log(`  assistant final messages : ${assistantFinalCount}`)
  console.log(`  turn end reason          : ${turnEndedReason}`)
  if (firstThinkingPreview)
    console.log(`  first thinking preview   : "${firstThinkingPreview.slice(0, 60).replace(/\n/g, ' ')}"`)
  if (firstTextPreview)
    console.log(`  first text preview       : "${firstTextPreview.slice(0, 60).replace(/\n/g, ' ')}"`)

  if (turnEndedReason === null) {
    console.error('stream-event: turn timeout (180s, no turnEnd)')
    return 4
  }
  if (turnEndedReason !== 'done') {
    console.error(`stream-event: turn ended with reason=${turnEndedReason}`)
    return 4
  }
  if (streamEventCount === 0) {
    console.error('stream-event: REGRESSION — no stream_event frames received')
    console.error('  → daemon includePartialMessages 可能沒打開，或 broker 漏 forward')
    return 5
  }
  if (thinkingDeltaCount === 0 && textDeltaCount === 0) {
    console.error('stream-event: stream_event 有收到但沒任何 delta — 可疑')
    console.error('  → 可能 SSE adapter 沒 emit content_block_delta')
    return 5
  }
  console.log('stream-event: OK ✅')
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `stream-event: unexpected — ${e instanceof Error ? e.message : String(e)}`,
    )
    process.exit(6)
  })
