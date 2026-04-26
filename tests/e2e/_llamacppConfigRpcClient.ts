/**
 * M-LLAMACPP-WATCHDOG Phase 4-3：daemon llamacpp config RPC + broadcast 真實驗證。
 *
 * 兩個 WS thin-client attach 進 daemon：
 *   A：送 llamacpp.configMutation (op=setWatchdog) → 收 configMutationResult ok
 *   B：在 1s 內收到 llamacpp.configChanged broadcast frame
 *
 * 用法：daemon 必須已起。
 *   bun run tests/e2e/_llamacppConfigRpcClient.ts
 *
 * Exit codes：
 *   0  全綠
 *   2  daemon 不在
 *   3  WS 連不上
 *   4  hello 10s 內沒到
 *   5  A 5s 內沒回 result
 *   6  A mutation 失敗
 *   7  B 5s 內沒收到 broadcast
 *   8  其他 unexpected
 */
import { readPidFile } from '../../src/daemon/pidFile.js'
import { readToken } from '../../src/daemon/authToken.js'
import {
  createThinClientSocket,
  type InboundFrame,
} from '../../src/repl/thinClient/thinClientSocket.js'

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(pollMs)
  }
  return false
}

async function main(): Promise<number> {
  const pid = await readPidFile()
  if (!pid) {
    console.error('llama-rpc: no pid.json')
    return 2
  }
  const token = await readToken()
  if (!token) {
    console.error('llama-rpc: no token')
    return 2
  }

  const sockA = createThinClientSocket({
    host: '127.0.0.1',
    port: pid.port,
    token,
    cwd: process.cwd(),
    source: 'repl',
    connectTimeoutMs: 5_000,
  })
  const sockB = createThinClientSocket({
    host: '127.0.0.1',
    port: pid.port,
    token,
    cwd: process.cwd(),
    source: 'repl',
    connectTimeoutMs: 5_000,
  })

  let helloA = false
  let helloB = false
  let resultA: { ok: boolean; error?: string } | null = null
  let broadcastB = false

  sockA.on('frame', (f: InboundFrame) => {
    if (f.type === 'hello') helloA = true
    if (f.type === 'llamacpp.configMutationResult') {
      const fr = f as unknown as { ok?: boolean; error?: string }
      resultA = { ok: !!fr.ok, error: fr.error }
    }
  })
  sockB.on('frame', (f: InboundFrame) => {
    if (f.type === 'hello') helloB = true
    if (f.type === 'llamacpp.configChanged') broadcastB = true
  })

  try {
    await Promise.all([sockA.connect(), sockB.connect()])
  } catch (e) {
    console.error(
      `llama-rpc: connect failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  if (!(await waitFor(() => helloA && helloB, 10_000))) {
    console.error('llama-rpc: hello timeout')
    sockA.close(); sockB.close()
    return 4
  }

  console.log('llama-rpc: both attached, sending setWatchdog mutation')

  // 送一個無害 mutation：master off + 三層 off（等於 reset）
  const watchdog = {
    enabled: false,
    interChunk: { enabled: false, gapMs: 30_000 },
    reasoning: { enabled: false, blockMs: 120_000 },
    tokenCap: {
      enabled: false,
      default: 16_000,
      memoryPrefetch: 256,
      sideQuery: 1_024,
      background: 4_000,
    },
  }
  sockA.send({
    type: 'llamacpp.configMutation',
    requestId: `lt-${Date.now()}`,
    op: 'setWatchdog',
    payload: watchdog,
  })

  if (!(await waitFor(() => resultA !== null, 5_000))) {
    console.error('llama-rpc: A no result within 5s')
    sockA.close(); sockB.close()
    return 5
  }
  if (!resultA!.ok) {
    console.error(`llama-rpc: A mutation failed — ${resultA!.error}`)
    sockA.close(); sockB.close()
    return 6
  }
  console.log('llama-rpc: A result ok')

  if (!(await waitFor(() => broadcastB, 5_000))) {
    console.error('llama-rpc: B no broadcast within 5s')
    sockA.close(); sockB.close()
    return 7
  }
  console.log('llama-rpc: B received llamacpp.configChanged broadcast — OK')

  sockA.close()
  sockB.close()
  return 0
}

main()
  .then(c => process.exit(c))
  .catch(e => {
    console.error(
      `llama-rpc: unexpected — ${e instanceof Error ? e.stack : String(e)}`,
    )
    process.exit(8)
  })
