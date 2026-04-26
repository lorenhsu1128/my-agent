/**
 * M-LLAMACPP-WATCHDOG Phase 4-1：Mock OpenAI SSE server。
 *
 * 用 Bun.serve 開最小 SSE endpoint，靠 query string 切換情境：
 *   /v1/chat/completions?scenario=fast       → 連 5 個 chunk 各 50ms 完整 stream
 *   /v1/chat/completions?scenario=hung-after-first → 1 個 chunk 後永遠不再吐
 *   /v1/chat/completions?scenario=reasoning-loop   → 持續 reasoning_content 永遠不收尾
 *   /v1/chat/completions?scenario=token-flood      → 持續 content 直到 client abort
 *
 * 用法：`bun run tests/e2e/_llamacppHungSimulator.ts <scenario> [port]`
 * 預設 port=18080（避開 llama.cpp 8080）。
 *
 * 此 simulator 純粹服務 watchdog 的 E2E 整合測；不模擬 llama.cpp 完整協議。
 *
 * Exit codes：
 *   0  - 任一 client 連完關掉（測試 OK）
 *   1  - server 起不來
 */

const scenario = (process.argv[2] ?? 'fast') as
  | 'fast'
  | 'hung-after-first'
  | 'reasoning-loop'
  | 'token-flood'
const port = Number(process.argv[3] ?? 18080)

const ENCODER = new TextEncoder()

function sseChunk(payload: object): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`)
}
function sseDone(): Uint8Array {
  return ENCODER.encode(`data: [DONE]\n\n`)
}

function makeChunk(opts: {
  reasoning?: string
  content?: string
  finish?: string | null
}): object {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-qwen',
    choices: [
      {
        index: 0,
        delta: {
          ...(opts.reasoning ? { reasoning_content: opts.reasoning } : {}),
          ...(opts.content ? { content: opts.content } : {}),
        },
        finish_reason: opts.finish ?? null,
      },
    ],
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

async function fastScenario(controller: ReadableStreamDefaultController): Promise<void> {
  for (let i = 0; i < 5; i++) {
    controller.enqueue(sseChunk(makeChunk({ content: `fast${i} ` })))
    await sleep(50)
  }
  controller.enqueue(sseChunk(makeChunk({ content: '', finish: 'stop' })))
  controller.enqueue(sseDone())
  controller.close()
}

async function hungAfterFirstScenario(
  controller: ReadableStreamDefaultController,
  signal: AbortSignal,
): Promise<void> {
  // 第 1 chunk
  controller.enqueue(sseChunk(makeChunk({ content: 'hello ' })))
  // 永遠不再吐 — 等 abort
  await new Promise<void>(resolve => {
    const onAbort = (): void => resolve()
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', onAbort, { once: true })
    // 安全閥：300 秒後自動關（防 simulator 自己卡死）
    setTimeout(resolve, 300_000)
  })
  try { controller.close() } catch {}
}

async function reasoningLoopScenario(
  controller: ReadableStreamDefaultController,
  signal: AbortSignal,
): Promise<void> {
  // 一直吐 reasoning_content 永遠不切回 content
  while (!signal.aborted) {
    controller.enqueue(sseChunk(makeChunk({ reasoning: 'Let me think... ' })))
    await sleep(100)
  }
  try { controller.close() } catch {}
}

async function tokenFloodScenario(
  controller: ReadableStreamDefaultController,
  signal: AbortSignal,
): Promise<void> {
  // 直接 content 但量很大、快速吐
  while (!signal.aborted) {
    // 每個 chunk 帶 90 個字（~30 tokens 估）
    controller.enqueue(
      sseChunk(makeChunk({ content: 'x'.repeat(90) + ' ' })),
    )
    await sleep(20)
  }
  try { controller.close() } catch {}
}

const server = Bun.serve({
  port,
  fetch(req: Request): Response {
    const url = new URL(req.url)
    if (url.pathname !== '/v1/chat/completions') {
      return new Response('not found', { status: 404 })
    }

    const stream = new ReadableStream({
      async start(controller) {
        const signal = req.signal
        try {
          if (scenario === 'fast') {
            await fastScenario(controller)
          } else if (scenario === 'hung-after-first') {
            await hungAfterFirstScenario(controller, signal)
          } else if (scenario === 'reasoning-loop') {
            await reasoningLoopScenario(controller, signal)
          } else if (scenario === 'token-flood') {
            await tokenFloodScenario(controller, signal)
          } else {
            controller.enqueue(
              sseChunk(makeChunk({ content: `unknown scenario: ${scenario}` })),
            )
            controller.close()
          }
        } catch {
          // ignore
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  },
})

console.log(`mock-llama-sse: listening port=${port} scenario=${scenario}`)

// 60 秒後自動關（避免 simulator 自己變孤兒）
setTimeout(() => {
  console.log('mock-llama-sse: 60s elapsed, shutting down')
  server.stop()
  process.exit(0)
}, 60_000)
