/**
 * M-DECOUPLE-3-3-3 (B 方案)：用 REPL 真正用的 `createFallbackManager` +
 * `createDaemonDetector` 走完一個完整 turn — 比 `_thinClientPing.ts` 更接近
 * REPL 行為，差別只剩 React 渲染（ink TUI 在 piped stdout 下會強制 non-interactive，
 * 真互動 REPL 測試需要 PTY，留給後續 milestone）。
 *
 * 流程：
 *   1. createDaemonDetector + createFallbackManager（帶 cwd → 走 hello frame）
 *   2. 等 mode → 'attached'
 *   3. sendInput('4+5 等於幾，只回阿拉伯數字')
 *   4. 監 'frame' → runnerEvent.event.type==='output', payload.type==='assistant'
 *      → 抽 message.content 裡的 text，累積
 *   5. 監 'frame' → turnEnd → 視為 turn 完成
 *   6. 累積 text 含 `\b9\b` → exit 0
 *
 * Exit codes：
 *   0  收到 9
 *   2  daemon 沒在跑
 *   3  attach timeout
 *   4  turn timeout 或 turnEnd reason !== 'done'
 *   5  output 不含 9
 *   6  unexpected error
 */
import { createDaemonDetector } from '../../src/repl/thinClient/detectDaemon.js'
import { createFallbackManager } from '../../src/repl/thinClient/fallbackManager.js'
import type { InboundFrame } from '../../src/repl/thinClient/thinClientSocket.js'

interface ContentBlock {
  type?: string
  text?: string
}

async function main(): Promise<number> {
  const detector = createDaemonDetector({ pollIntervalMs: 500 })
  const snap = await detector.check()
  if (!snap.alive) {
    console.error('thin-client-turn: daemon not alive')
    detector.stop()
    return 2
  }

  const mgr = createFallbackManager({
    detector,
    cwd: process.cwd(),
    source: 'repl',
    reconnectTimeoutMs: 10_000,
  })

  // 等 attached（最多 15s — daemon load project 可能較慢）
  const attachDeadline = Date.now() + 15_000
  while (mgr.state.mode !== 'attached' && Date.now() < attachDeadline) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (mgr.state.mode !== 'attached') {
    console.error(
      `thin-client-turn: attach timeout (mode=${mgr.state.mode}, lastReject=${mgr.lastAttachRejectedReason ?? 'n/a'})`,
    )
    await mgr.stop()
    detector.stop()
    return 3
  }
  console.log('thin-client-turn: attached')

  let assistantText = ''
  let turnEndedReason: string | null = null
  mgr.on('frame', (f: InboundFrame) => {
    if (f.type === 'hello') {
      const fh = f as { state?: string; currentInputId?: string }
      console.log(
        `thin-client-turn: hello state=${fh.state} currentInputId=${fh.currentInputId ?? 'none'}`,
      )
      return
    }
    if (f.type === 'state') {
      const fs = f as { state?: string }
      console.log(`thin-client-turn: state→${fs.state}`)
      return
    }
    if (f.type === 'turnStart') {
      const ft = f as { inputId?: string }
      console.log(
        `thin-client-turn: turnStart inputId=${ft.inputId?.slice(0, 8)}`,
      )
      return
    }
    if (f.type === 'turnEnd') {
      const fe = f as { reason?: string; inputId?: string; error?: string }
      console.log(
        `thin-client-turn: turnEnd inputId=${fe.inputId?.slice(0, 8)} reason=${fe.reason} err=${fe.error ?? ''}`,
      )
      turnEndedReason = fe.reason ?? 'unknown'
      return
    }
    if (f.type !== 'runnerEvent') return
    const evt = (f as { event?: { type?: string; payload?: unknown } }).event
    if (!evt || evt.type !== 'output') return
    const sdk = evt.payload as {
      type?: string
      message?: { content?: ContentBlock[] }
    }
    if (sdk?.type !== 'assistant') return
    const blocks = sdk.message?.content
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        assistantText += b.text
      }
    }
  })

  console.log('thin-client-turn: sendInput 4+5')
  mgr.sendInput('4+5 等於幾，只回一個阿拉伯數字', 'interactive')

  const turnDeadline = Date.now() + 120_000
  while (turnEndedReason === null && Date.now() < turnDeadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  await mgr.stop()
  detector.stop()

  if (turnEndedReason === null) {
    console.error('thin-client-turn: turn timeout (120s, no turnEnd)')
    return 4
  }
  if (turnEndedReason !== 'done') {
    console.error(`thin-client-turn: turn ended with reason=${turnEndedReason}`)
    return 4
  }
  console.log(`thin-client-turn: turnEnd done; output="${assistantText.trim()}"`)
  if (!/\b9\b/.test(assistantText)) {
    console.error('thin-client-turn: output does not contain 9')
    return 5
  }
  console.log('thin-client-turn: OK')
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `thin-client-turn: unexpected — ${e instanceof Error ? e.message : String(e)}`,
    )
    process.exit(6)
  })
