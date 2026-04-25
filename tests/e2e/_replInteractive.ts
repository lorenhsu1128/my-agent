/**
 * M-DECOUPLE-3-6 (c 方案)：PTY-based 互動 REPL E2E。
 *
 * 為什麼要這個（vs `_thinClientTurn.ts` 的 b 方案）：
 *   b 方案直接用 `createFallbackManager` + `createDaemonDetector`，跑 sendInput
 *   等 turnEnd，但 **跳過整個 React/ink 渲染那層**。如果未來改 `<Messages>`
 *   元件造成 assistant 文字沒進螢幕（typecheck + b 都過），互動 REPL 用戶會
 *   看到 spinner 跑完螢幕一片空 — daemon/LLM/WS 都好但 TUI sink hole。
 *   這個檔補上那條最後一哩。
 *
 * 流程：
 *   Phase 1：spawn ./cli-dev[.exe] 透過 PTY，等 60s 看 stdout 出現
 *            `Daemon 已連線`（REPL.tsx:4302-4308 的 onModeChange→attached
 *            印的 system message） — 確認 ink + daemon attach 都活
 *   Phase 2：write `4+5 等於幾，只回一個阿拉伯數字\r`，等 120s 看 attach
 *            marker 之後 stdout 出現 `\b9\b` — 確認 runnerEvent → setMessages
 *            → ink re-render → ANSI stdout 整鏈通
 *   Cleanup：write Ctrl-C (`\x03`) → 500ms → kill
 *
 * 跨平台：node-pty 抽象 ConPTY (Windows) / PTY (macOS, Linux)。binary 三層
 *   cascade `cli-dev.exe → cli-dev → cli`（macOS dev build 無副檔名）。
 *   Windows ConPTY emit ANSI 比 macOS PTY 多很多（DEC private mode + OSC
 *   window title），用 `strip-ansi`（已是 transitive dep，從 chalk/ink 拉進）
 *   覆蓋兩平台。
 *
 * Exit codes：
 *   0  全綠
 *   2  daemon 沒在跑（pid.json 預檢失敗）
 *   3  PTY 起不來（node-pty load 或 spawn throw）
 *   4  Phase 1 attach marker 60s 內未見
 *   5  Phase 2「9」120s 內未見（最可能是 ink `<Messages>` 渲染壞）
 *   6  其他 unexpected
 */
import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import stripAnsi from 'strip-ansi'

// Self-contained — 不 import 專案 TS。
//
// **必須用 node（透過 tsx）跑，不用 bun**：
//   `npx tsx tests/e2e/_replInteractive.ts`
// Bun 1.3.12 + node-pty 在 Windows + ink alt-screen mode 下會撞 async
// ERR_SOCKET_CLOSED（node-pty 內部 net.Socket 在 ink 進 raw mode 後失效，
// 異常從 node:net:888 拋出無法 try/catch）。Node + node-pty 配對是 node-pty
// 設計目標，路徑穩定。Phase 1 在 Bun 下能過、Phase 2 term.write 必 throw。
// 整合測試 J section 內固定走 `npx tsx`。
interface PidFile {
  pid: number
  port: number
  startedAt: number
  lastHeartbeat: number
  agentVersion?: string
}

function readPidFile(): PidFile | null {
  const path = join(homedir(), '.my-agent', 'daemon.pid.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PidFile
  } catch {
    return null
  }
}

// node-pty.spawn 在 Windows ConPTY 下需要絕對路徑（相對 './cli-dev.exe' 會
// 直接 'File not found'）；macOS PTY 接受相對路徑但用絕對也 OK，統一吃絕對。
function pickBinary(): string | null {
  for (const candidate of ['./cli-dev.exe', './cli-dev', './cli']) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  pollMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(pollMs)
  }
  return false
}

async function main(): Promise<number> {
  const pid = readPidFile()
  if (!pid) {
    console.error('repl-interactive: daemon not running (no pid.json)')
    return 2
  }

  const bin = pickBinary()
  if (!bin) {
    console.error(
      'repl-interactive: no binary found (./cli-dev.exe / ./cli-dev / ./cli)',
    )
    return 2
  }

  let pty: typeof import('node-pty')
  try {
    pty = await import('node-pty')
  } catch (e) {
    console.error(
      `repl-interactive: node-pty load failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  console.log(`repl-interactive: spawning ${bin} via PTY (daemon pid=${pid.pid})`)
  let term: import('node-pty').IPty
  try {
    term = pty.spawn(bin, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    })
  } catch (e) {
    console.error(
      `repl-interactive: spawn failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  let raw = ''
  let exited: { exitCode: number; signal?: number } | null = null
  term.onData((data: string) => {
    raw += data
  })
  term.onExit(e => {
    exited = e
  })

  // Cleanup helper — Ctrl-C → kill
  const cleanup = async (): Promise<void> => {
    try {
      term.write('\x03')
      await sleep(500)
    } catch {
      // ignore — process may already be dead
    }
    try {
      term.kill()
    } catch {
      // ignore
    }
  }

  // Phase 1：等 60s 看到 attach marker。
  // REPL.tsx:4302-4308 印「Daemon 已連線 — 後續輸入送到 daemon...」
  const ATTACH_MARKER = 'Daemon 已連線'
  const phase1OK = await waitFor(
    () => stripAnsi(raw).includes(ATTACH_MARKER),
    60_000,
    250,
  )
  if (!phase1OK) {
    console.error(
      `repl-interactive: phase1 failed — '${ATTACH_MARKER}' not seen in 60s`,
    )
    console.error(`repl-interactive: raw stdout (last 400 chars, ANSI stripped):`)
    console.error(stripAnsi(raw).slice(-400))
    await cleanup()
    return 4
  }
  console.log('phase1: attached marker seen — ink + daemon attach OK')

  // 等 1s 讓 ink 穩定（input box / status line 完全 render 完）
  await sleep(1000)
  if (exited) {
    console.error(
      `repl-interactive: cli exited unexpectedly after phase1 — code=${(exited as { exitCode: number }).exitCode}`,
    )
    return 5
  }

  // Phase 2：送 prompt、等 stdout 出現「9」（在 attach marker 之後）。
  // 用 baseLength snapshot 而非 split — split 會被 marker 在 stdout 出現多次時
  // 搞亂；baseLength 直接取 attach 那刻的長度，後面新增的才算 turn 輸出。
  const baseLength = stripAnsi(raw).length
  // ink raw mode 下 Enter key — `\r` 在 ConPTY 進輸入框但不觸發 submit；
  // 改先寫文字、稍等 ink 接住、再送 `\r` 單獨當 Enter（ink-text-input
  // 內部 onKeyPress 會看 input.return / key.return 才呼叫 onSubmit）。
  try {
    term.write('4+5 等於幾，只回一個阿拉伯數字')
    await sleep(300)
    term.write('\r')
  } catch (e) {
    console.error(
      `repl-interactive: phase2 term.write threw — ${e instanceof Error ? e.message : String(e)}`,
    )
    console.error(
      `repl-interactive: process exited=${JSON.stringify(exited)}, raw len=${raw.length}`,
    )
    return 5
  }

  const NINE_RE = /\b9\b/
  const phase2OK = await waitFor(
    () => {
      const stripped = stripAnsi(raw)
      const afterAttach = stripped.slice(baseLength)
      return NINE_RE.test(afterAttach)
    },
    120_000,
    300,
  )
  if (!phase2OK) {
    console.error(
      `repl-interactive: phase2 failed — '\\b9\\b' not seen in 120s after attach`,
    )
    console.error(
      `repl-interactive: full stripped stdout after attach (${stripAnsi(raw).length - baseLength} chars):`,
    )
    console.error('===STDOUT-AFTER-ATTACH-START===')
    console.error(stripAnsi(raw).slice(baseLength))
    console.error('===STDOUT-AFTER-ATTACH-END===')
    await cleanup()
    return 5
  }
  console.log('phase2: answer 9 seen in rendered output — <Messages> 渲染 OK')

  await cleanup()
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `repl-interactive: unexpected — ${e instanceof Error ? e.stack : String(e)}`,
    )
    process.exit(6)
  })
