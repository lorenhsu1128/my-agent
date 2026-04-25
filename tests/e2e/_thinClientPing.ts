/**
 * M-DECOUPLE-3-3：thin-client smoke。
 *
 * 真實打開一個 WS 連線到 daemon、等 `hello` frame、送一個 `permissionContextSync`
 * 後關閉。比 `cli -p` 更精準 — `-p` print 模式不走 thin-client，只能驗 LLM 通而已。
 *
 * 用法：daemon 必須已啟動。
 *   bun run tests/e2e/_thinClientPing.ts
 *
 * 輸出（成功）：
 *   thin-client-ping: connected port=<n> token=<8>...
 *   thin-client-ping: hello received sessionId=<8>...
 *   thin-client-ping: ack OK
 *   exit 0
 *
 * Exit codes：
 *   0  全程順利、收到 hello
 *   2  daemon 沒在跑（pid.json/token 讀不到）
 *   3  WS 連不上
 *   4  10 秒內沒收到 hello frame
 *   5  其他 unexpected error
 */
import { readPidFile } from '../../src/daemon/pidFile.js'
import { readToken } from '../../src/daemon/authToken.js'
import {
  createThinClientSocket,
  type InboundFrame,
} from '../../src/repl/thinClient/thinClientSocket.js'

async function main(): Promise<number> {
  const pid = await readPidFile()
  if (!pid) {
    console.error('thin-client-ping: no pid.json — daemon not running')
    return 2
  }
  const token = await readToken()
  if (!token) {
    console.error('thin-client-ping: no token file')
    return 2
  }
  console.log(
    `thin-client-ping: connecting port=${pid.port} token=${token.slice(0, 8)}...`,
  )

  const socket = createThinClientSocket({
    host: '127.0.0.1',
    port: pid.port,
    token,
    cwd: process.cwd(),
    source: 'repl',
    connectTimeoutMs: 5_000,
  })

  let helloReceived = false
  let helloSessionId = ''
  socket.on('frame', (f: InboundFrame) => {
    if (f.type === 'hello') {
      helloReceived = true
      helloSessionId =
        typeof f.sessionId === 'string' ? f.sessionId.slice(0, 8) : '?'
      console.log(`thin-client-ping: hello received sessionId=${helloSessionId}`)
    }
  })

  try {
    await socket.connect()
  } catch (e) {
    console.error(
      `thin-client-ping: connect failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }
  console.log('thin-client-ping: connected')

  // Hello frame 在 daemon side load project 完才會送（M-CWD-FIX）— 等 10s 上限。
  const helloDeadline = Date.now() + 10_000
  while (!helloReceived && Date.now() < helloDeadline) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (!helloReceived) {
    console.error('thin-client-ping: timeout waiting for hello frame (10s)')
    socket.close()
    return 4
  }

  // 送一個無副作用的 frame，驗 outbound 路徑也通。permissionContextSync 是
  // daemon 的同步點：daemon 收到後不回 frame，但會更新 internal state；
  // 我們只要 ws.send 不 throw 就算過。
  try {
    socket.send({ type: 'permissionContextSync', mode: 'default' })
    console.log('thin-client-ping: ack OK')
  } catch (e) {
    console.error(
      `thin-client-ping: send failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    socket.close()
    return 5
  }

  // 給 daemon 100ms 處理完再 close，避免 server 端沒讀到 frame
  await new Promise(r => setTimeout(r, 100))
  socket.close()
  return 0
}

main()
  .then(code => {
    process.exit(code)
  })
  .catch(e => {
    console.error(
      `thin-client-ping: unexpected — ${e instanceof Error ? e.message : String(e)}`,
    )
    process.exit(5)
  })
