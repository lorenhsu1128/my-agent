// Wave 3 — classify a cron fire as success or failure for retry purposes.
//
// FailureMode kinds (defined on CronTask in cronTasks.ts):
//   turn-error      — turn ended with reason !== 'done'
//   pre-run-exit    — preRunScript exit ≠ 0 (must be detected at fire time
//                      and surfaced to the classifier via preRunFailed flag)
//   output-regex    — turn output text matches the regex
//   output-missing  — turn output text does NOT contain the pattern
//   composite       — combine sub-modes with any/all logic

import type { FailureMode } from './cronTasks.js'

export type FireOutcomeInputs = {
  /** turnEnd.reason — 'done' = success, anything else = error/abort. */
  turnReason: 'done' | 'error' | 'aborted' | string
  /** turnEnd.error — populated when reason !== 'done'. */
  turnError?: string
  /** Concatenated text output from runnerEvent payloads. */
  output: string
  /** True iff preRunScript ran and exited non-zero. */
  preRunFailed: boolean
}

export type FireResult = 'ok' | 'error'

export function classifyFireResult(
  inputs: FireOutcomeInputs,
  mode: FailureMode | undefined,
): FireResult {
  // No mode declared → fall back to "turn-error" semantics (sensible default
  // matching pre-W3 behavior where any non-done turn was failure).
  if (!mode) {
    return inputs.turnReason === 'done' && !inputs.preRunFailed
      ? 'ok'
      : 'error'
  }
  return evaluate(mode, inputs) ? 'error' : 'ok'
}

function evaluate(mode: FailureMode, inputs: FireOutcomeInputs): boolean {
  switch (mode.kind) {
    case 'turn-error':
      return inputs.turnReason !== 'done'
    case 'pre-run-exit':
      return inputs.preRunFailed
    case 'output-regex': {
      try {
        const re = new RegExp(mode.pattern, mode.flags ?? '')
        return re.test(inputs.output)
      } catch {
        // Invalid regex → never match (fail open: never count as failure).
        return false
      }
    }
    case 'output-missing':
      return !inputs.output.includes(mode.pattern)
    case 'composite': {
      const results = mode.modes.map(m => evaluate(m, inputs))
      return mode.logic === 'all'
        ? results.every(Boolean)
        : results.some(Boolean)
    }
  }
}

/**
 * Best-effort text extraction from a runner output payload (SDKMessage or
 * arbitrary). Used by the cron retry path to evaluate output-regex /
 * output-missing failure modes. Tolerates unknown shapes.
 */
export function extractRunnerOutputText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  const obj = payload as Record<string, unknown>
  // SDKMessage of type 'result' has top-level result string.
  if (typeof obj.result === 'string') return obj.result
  // Assistant SDKMessage: { message: { content: [{ type:'text', text:'...' }] } }
  const message = obj.message as Record<string, unknown> | undefined
  if (message) {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return (message.content as Array<Record<string, unknown>>)
        .map(c => (typeof c.text === 'string' ? c.text : ''))
        .join('')
    }
  }
  // Plain { text: '...' } chunk (fallback / echo runner shape).
  if (typeof obj.text === 'string') return obj.text
  return ''
}

/** Backoff = base * 2^(attempt-1), capped at 1 hour. */
export function computeBackoffMs(baseMs: number, attempt: number): number {
  const ms = baseMs * Math.pow(2, Math.max(0, attempt - 1))
  return Math.min(ms, 60 * 60 * 1000)
}
