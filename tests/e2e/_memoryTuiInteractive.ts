/**
 * M-MEMTUI Phase 5：/memory TUI PTY interactive smoke。
 *
 * 涵蓋 K4 + K5：
 *   Phase 1：spawn ./cli-dev[.exe]，send `/memory<Enter>`，等 60s 看 stdout
 *            出現 5 個 tab label（auto-memory / USER / project / local-config / daily-log）
 *            + 確認 active marker `‹ auto-memory ›`
 *   Phase 2：send `→` 4 次，每次小延遲；最後 stdout 應出現 `‹ daily-log ›`
 *            （表示 ←/→ 切到第 5 個 tab）
 *   Cleanup：Ctrl-C → kill
 *
 * 跨平台：sa同 J section pattern — node-pty + npx tsx，三層 binary cascade。
 *
 * Exit codes：
 *   0  全綠
 *   2  daemon / binary 預檢失敗
 *   3  PTY load / spawn 失敗
 *   4  Phase 1 60s 內未見 5 tab label
 *   5  Phase 2 60s 內未見 daily-log 切換結果
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

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
    console.error('mem-tui: no binary')
    return 2
  }

  let pty: typeof import('node-pty')
  try {
    pty = await import('node-pty')
  } catch (e) {
    console.error(
      `mem-tui: node-pty load failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  console.log(`mem-tui: spawning ${bin} via PTY`)
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
      `mem-tui: spawn failed — ${e instanceof Error ? e.message : String(e)}`,
    )
    return 3
  }

  let raw = ''
  term.onData((data: string) => {
    raw += data
  })

  const cleanup = async (): Promise<void> => {
    try {
      term.write('\x03')
      await sleep(500)
    } catch {}
    try {
      term.kill()
    } catch {}
  }

  // 等 REPL 起完（看到 input box prompt > 或 banner）
  await sleep(3000)

  // 送 /memory + Enter
  term.write('/memory')
  await sleep(300)
  term.write('\r')

  // Phase 1：等 5 tab label + 第一個 active marker
  const TAB_LABELS = ['auto-memory', 'USER', 'project', 'local-config', 'daily-log']
  const phase1OK = await waitFor(
    () => {
      const s = stripAnsi(raw)
      return TAB_LABELS.every(l => s.includes(l)) && s.includes('‹ auto-memory ›')
    },
    60_000,
  )
  if (!phase1OK) {
    console.error('mem-tui: phase1 — 5 tab labels / active marker 未見')
    console.error(stripAnsi(raw).slice(-600))
    await cleanup()
    return 4
  }
  console.log('mem-tui: phase1 OK — 5 tab + active marker visible')

  // Phase 2：送 → 四次，最後應見 ‹ daily-log ›
  for (let i = 0; i < 4; i++) {
    // node-pty send right arrow: ESC [ C
    term.write('\x1b[C')
    await sleep(400)
  }

  // 搜整個 stripped output（不 slice — baseLen 在 raw 上，stripAnsi 後位置會 drift）
  const phase2OK = await waitFor(
    () => stripAnsi(raw).includes('‹ daily-log ›'),
    60_000,
  )
  if (!phase2OK) {
    console.error('mem-tui: phase2 — daily-log active marker 未見')
    console.error(stripAnsi(raw).slice(-600))
    await cleanup()
    return 5
  }
  console.log('mem-tui: phase2 OK — ←/→ 切到 daily-log')

  await cleanup()
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(
      `mem-tui: unexpected — ${e instanceof Error ? e.stack : String(e)}`,
    )
    process.exit(6)
  })
