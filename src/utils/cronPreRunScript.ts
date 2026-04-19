// Pre-run script execution for Wave 2 cron tasks. When a CronTask has
// `preRunScript` set, we shell-execute it before each fire and prepend the
// (redacted) stdout to the prompt as a `## Context` block. The execution
// is bounded by a 10s timeout so a hung script cannot stall the fire loop;
// stderr and exit codes are swallowed but logged for debugging. Secrets
// in stdout are masked via redactSecrets before they can reach the model.

import { spawn } from 'child_process'
import { logForDebugging } from './debug.js'
import { redactSecrets } from './web/secretScan.js'

const PRE_RUN_TIMEOUT_MS = 10_000
const MAX_STDOUT_CHARS = 8_000

export type PreRunResult = {
  ok: boolean
  /** Redacted stdout. Empty string means "ran OK but produced nothing". */
  stdout: string
  /** Set when the script failed (non-zero exit, timeout, or spawn error). */
  error?: string
}

/**
 * Run `command` via the platform shell, with a hard timeout. Returns
 * redacted stdout (capped at MAX_STDOUT_CHARS) and an error message if the
 * script failed. Never throws — failures are surfaced as `ok: false` so the
 * scheduler can fall back to the un-augmented prompt.
 */
export async function runPreRunScript(command: string): Promise<PreRunResult> {
  return new Promise(resolve => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (e) {
      resolve({
        ok: false,
        stdout: '',
        error: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }

    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      logForDebugging(
        `[cronPreRunScript] timed out after ${PRE_RUN_TIMEOUT_MS}ms: ${command}`,
      )
      resolve({
        ok: false,
        stdout: redactSecrets(stdoutBuf.slice(0, MAX_STDOUT_CHARS)),
        error: `timed out after ${PRE_RUN_TIMEOUT_MS}ms`,
      })
    }, PRE_RUN_TIMEOUT_MS)

    child.stdout?.on('data', chunk => {
      stdoutBuf += chunk.toString()
      // Protect against a runaway process spewing GBs of stdout.
      if (stdoutBuf.length > MAX_STDOUT_CHARS * 4) {
        stdoutBuf = stdoutBuf.slice(0, MAX_STDOUT_CHARS * 4)
      }
    })
    child.stderr?.on('data', chunk => {
      stderrBuf += chunk.toString()
    })

    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: false,
        stdout: '',
        error: `spawn error: ${err.message}`,
      })
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = redactSecrets(stdoutBuf.slice(0, MAX_STDOUT_CHARS))
      if (code === 0) {
        resolve({ ok: true, stdout })
      } else {
        if (stderrBuf.length > 0) {
          logForDebugging(
            `[cronPreRunScript] exit=${code} stderr=${stderrBuf.slice(0, 300)}`,
          )
        }
        resolve({
          ok: false,
          stdout,
          error: `exit code ${code}`,
        })
      }
    })
  })
}

/**
 * Format a pre-run stdout into a Markdown context block prepended to the
 * cron prompt. Returns the prompt unchanged when `result` has no useful
 * stdout (failed and produced nothing, or succeeded but was silent).
 */
export function augmentPromptWithPreRun(
  prompt: string,
  result: PreRunResult,
): string {
  const trimmed = result.stdout.trim()
  if (!trimmed) return prompt
  const header = result.ok
    ? `## Context (from preRunScript)`
    : `## Context (preRunScript failed: ${result.error ?? 'unknown'} — partial stdout below)`
  // Fence needs to be longer than any backtick run in the output.
  const longestRun = (trimmed.match(/`+/g) ?? []).reduce(
    (m, r) => Math.max(m, r.length),
    0,
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${header}\n\n${fence}\n${trimmed}\n${fence}\n\n${prompt}`
}
