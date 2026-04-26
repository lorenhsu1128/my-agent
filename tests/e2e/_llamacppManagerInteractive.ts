/**
 * M-LLAMACPP-WATCHDOG Phase 4-2：/llamacpp TUI PTY interactive smoke。
 *
 * 涵蓋 L7：
 *   Phase 1：spawn ./cli-dev[.exe]，send `/llamacpp<Enter>`，等 60s 看 stdout
 *            出現 `‹ Watchdog ›` 與 `‹ Slots ›` 兩個 tab label + 至少一個 `Master enabled`
 *   Phase 2：send `→` 一次，等看到 `‹ Slots ›` active marker 切換
 *
 * 跨平台：sa同 J/K section pattern — node-pty + npx tsx，三層 binary cascade。
 *
 * Exit codes：
 *   0  全綠
 *   2  binary 預檢失敗
 *   3  PTY load / spawn 失敗
 *   4  Phase 1 60s 內未見 ‹ Watchdog › / Master enabled
 *   5  Phase 2 60s 內未見 ‹ Slots › 切換
 *   6  其他 unexpected
 */
import { existsSync } from 'fs'
import { resolve } from 'path'
import stripAnsi from 'strip-ansi'

function pickBinary(): string | null {
  for (const c of ['./cli-dev.exe', './cli-dev', './cli']) {
    if (existsSync(c)) return resolve(c)
  }
  return null
}

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(pollMs)
  }
  return false
}

async function main(): Promise<number> {
  const bin = pickBinary()
  if (!bin) {
    console.error('llamacpp-tui: no binary')
    return 2
  }

  let pty: typeof import('node-pty')
  try {
    pty = await import('node-pty')
  } catch (e) {
    console.error(
      `llamacpp-tui: node-pty load failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  console.log(`llamacpp-tui: spawning ${bin} via PTY`)
  let term: import('node-pty').IPty
  try {
    term = pty.spawn(bin, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    })
  } catch (e) {
    console.error(
      `llamacpp-tui: spawn failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  let raw = ''
  term.onData((data: string) => {
    raw += data
  })

  const cleanup = async (): Promise<void> => {
    try { term.write('\x03'); await sleep(500) } catch {}
    try { term.kill() } catch {}
  }

  // 等 REPL 起完
  await sleep(3000)

  term.write('/llamacpp')
  await sleep(300)
  term.write('\r')

  // Phase 1：等 ‹ Watchdog › active + Slots tab + Master 字樣（ConPTY 在
  // Windows 會 strip 連續空格，所以不能 grep 整串「Master enabled」— 改抓
  // 「Master」+ 後面有「enabled」）
  const phase1OK = await waitFor(
    () => {
      const s = stripAnsi(raw)
      return (
        s.includes('‹ Watchdog ›') &&
        /\bSlots\b/.test(s) &&
        /Master\s*enabled/.test(s)
      )
    },
    60_000,
  )
  if (!phase1OK) {
    console.error('llamacpp-tui: phase1 — Watchdog tab / Master 未見')
    console.error(stripAnsi(raw).slice(-600))
    await cleanup()
    return 4
  }
  console.log('llamacpp-tui: phase1 OK — Watchdog tab + Master 看見')

  // Phase 2：→ 切到 Slots
  term.write('\x1b[C')
  const phase2OK = await waitFor(
    () => stripAnsi(raw).includes('‹ Slots ›'),
    60_000,
  )
  if (!phase2OK) {
    console.error('llamacpp-tui: phase2 — Slots active marker 未見')
    console.error(stripAnsi(raw).slice(-600))
    await cleanup()
    return 5
  }
  console.log('llamacpp-tui: phase2 OK — ‹ Slots › 切到')

  await cleanup()
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `llamacpp-tui: unexpected — ${e instanceof Error ? e.stack : String(e)}`,
    )
    process.exit(6)
  })
