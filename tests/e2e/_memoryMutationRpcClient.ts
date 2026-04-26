/**
 * M-MEMTUI Phase 5：daemon memory mutation RPC + broadcast 真實驗證。
 *
 * 兩個 WS thin-client 同 cwd attach 進 daemon：
 *   A：送 memory.mutation create → 收 memory.mutationResult ok
 *   B：在 1s 內收到 memory.itemsChanged broadcast frame
 *
 * 用法：daemon 必須已起、`./cli-dev[.exe]` 已 build。
 *   bun run tests/e2e/_memoryMutationRpcClient.ts
 *
 * Exit codes：
 *   0  全綠（A mutation ok + B 收到 broadcast）
 *   2  daemon 不在
 *   3  WS 連不上
 *   4  hello frame 10s 內沒到
 *   5  A mutation 5s 內沒回 result
 *   6  A mutation 失敗
 *   7  B 5s 內沒收到 itemsChanged broadcast
 *   8  其他 unexpected
 */
import { readPidFile } from '../../src/daemon/pidFile.js'
import { readToken } from '../../src/daemon/authToken.js'
import {
  createThinClientSocket,
  type InboundFrame,
} from '../../src/repl/thinClient/thinClientSocket.js'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAutoMemPath } from '../../src/memdir/paths.js'

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(r => setTimeout(r, pollMs))
  }
  return false
}

async function main(): Promise<number> {
  const pid = await readPidFile()
  if (!pid) {
    console.error('mem-rpc: no pid.json — daemon not running')
    return 2
  }
  const token = await readToken()
  if (!token) {
    console.error('mem-rpc: no token file')
    return 2
  }

  const filename = `e2etest_K12_${Date.now()}.md`
  const memDir = getAutoMemPath()
  const filePath = join(memDir, filename)

  // 兩個 socket 同時 attach
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
    if (f.type === 'memory.mutationResult') {
      const fr = f as unknown as { ok?: boolean; error?: string }
      resultA = { ok: !!fr.ok, error: fr.error }
    }
  })
  sockB.on('frame', (f: InboundFrame) => {
    if (f.type === 'hello') helloB = true
    if (f.type === 'memory.itemsChanged') {
      broadcastB = true
    }
  })

  try {
    await Promise.all([sockA.connect(), sockB.connect()])
  } catch (e) {
    console.error(
      `mem-rpc: connect failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  if (!(await waitFor(() => helloA && helloB, 10_000))) {
    console.error('mem-rpc: timeout waiting hello (10s)')
    sockA.close()
    sockB.close()
    return 4
  }
  console.log(`mem-rpc: both clients attached, sending create mutation`)

  // A 送 create
  sockA.send({
    type: 'memory.mutation',
    requestId: `mt-${Date.now()}`,
    op: 'create',
    payload: {
      kind: 'auto-memory',
      filename,
      name: 'K12-rpc',
      description: 'rpc broadcast e2e',
      type: 'feedback',
      body: 'rpc body',
    },
  })

  if (!(await waitFor(() => resultA !== null, 5_000))) {
    console.error('mem-rpc: A no result within 5s')
    sockA.close()
    sockB.close()
    return 5
  }
  if (!resultA!.ok) {
    console.error(`mem-rpc: A mutation failed — ${resultA!.error}`)
    sockA.close()
    sockB.close()
    return 6
  }
  console.log('mem-rpc: A result ok')

  if (!(await waitFor(() => broadcastB, 5_000))) {
    console.error('mem-rpc: B no broadcast within 5s')
    sockA.close()
    sockB.close()
    // Cleanup written file
    try { unlinkSync(filePath) } catch {}
    return 7
  }
  console.log('mem-rpc: B received memory.itemsChanged broadcast — OK')

  sockA.close()
  sockB.close()
  // Cleanup
  try { unlinkSync(filePath) } catch {}
  if (existsSync(filePath)) {
    console.error(`mem-rpc: warning — ${filename} not cleaned`)
  }
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `mem-rpc: unexpected — ${e instanceof Error ? e.stack : String(e)}`,
    )
    process.exit(8)
  })
