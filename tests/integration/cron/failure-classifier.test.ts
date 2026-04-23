import { describe, expect, test } from 'bun:test'
import {
  classifyFireResult,
  computeBackoffMs,
  extractRunnerOutputText,
  type FireOutcomeInputs,
} from '../../../src/utils/cronFailureClassifier'
import type { FailureMode } from '../../../src/utils/cronTasks'

const inputs = (over: Partial<FireOutcomeInputs> = {}): FireOutcomeInputs => ({
  turnReason: 'done',
  output: '',
  preRunFailed: false,
  ...over,
})

describe('cronFailureClassifier', () => {
  // --- no mode (default) ---------------------------------------------------

  test('no mode — done turn + preRun ok → ok', () => {
    expect(classifyFireResult(inputs(), undefined)).toBe('ok')
  })

  test('no mode — turn error → error', () => {
    expect(
      classifyFireResult(inputs({ turnReason: 'error' }), undefined),
    ).toBe('error')
  })

  test('no mode — preRun failed → error', () => {
    expect(classifyFireResult(inputs({ preRunFailed: true }), undefined)).toBe(
      'error',
    )
  })

  // --- turn-error ----------------------------------------------------------

  test('turn-error: done → ok', () => {
    expect(classifyFireResult(inputs(), { kind: 'turn-error' })).toBe('ok')
  })

  test('turn-error: aborted → error', () => {
    expect(
      classifyFireResult(inputs({ turnReason: 'aborted' }), {
        kind: 'turn-error',
      }),
    ).toBe('error')
  })

  // --- pre-run-exit --------------------------------------------------------

  test('pre-run-exit: preRunFailed → error', () => {
    expect(
      classifyFireResult(inputs({ preRunFailed: true }), {
        kind: 'pre-run-exit',
      }),
    ).toBe('error')
  })

  test('pre-run-exit: preRun ok + turn error → ok (only preRun matters)', () => {
    expect(
      classifyFireResult(
        inputs({ preRunFailed: false, turnReason: 'error' }),
        { kind: 'pre-run-exit' },
      ),
    ).toBe('ok')
  })

  // --- output-regex --------------------------------------------------------

  test('output-regex: match → error', () => {
    expect(
      classifyFireResult(inputs({ output: 'ERROR: timeout' }), {
        kind: 'output-regex',
        pattern: '^ERROR',
      }),
    ).toBe('error')
  })

  test('output-regex: no match → ok', () => {
    expect(
      classifyFireResult(inputs({ output: 'all good' }), {
        kind: 'output-regex',
        pattern: '^ERROR',
      }),
    ).toBe('ok')
  })

  test('output-regex: case-insensitive via flags', () => {
    expect(
      classifyFireResult(inputs({ output: 'oops FAILED big time' }), {
        kind: 'output-regex',
        pattern: 'failed',
        flags: 'i',
      }),
    ).toBe('error')
  })

  test('output-regex: invalid pattern → never matches (ok)', () => {
    expect(
      classifyFireResult(inputs({ output: 'anything' }), {
        kind: 'output-regex',
        pattern: '[unclosed',
      }),
    ).toBe('ok')
  })

  // --- output-missing ------------------------------------------------------

  test('output-missing: pattern absent → error', () => {
    expect(
      classifyFireResult(inputs({ output: 'done; nothing special' }), {
        kind: 'output-missing',
        pattern: 'SUCCESS',
      }),
    ).toBe('error')
  })

  test('output-missing: pattern present → ok', () => {
    expect(
      classifyFireResult(inputs({ output: 'final SUCCESS reached' }), {
        kind: 'output-missing',
        pattern: 'SUCCESS',
      }),
    ).toBe('ok')
  })

  // --- composite -----------------------------------------------------------

  test('composite any: any sub-mode failing → error', () => {
    const mode: FailureMode = {
      kind: 'composite',
      logic: 'any',
      modes: [
        { kind: 'turn-error' },
        { kind: 'output-regex', pattern: 'oops' },
      ],
    }
    // Turn done, but output has 'oops' → second sub triggers
    expect(
      classifyFireResult(inputs({ output: 'oops' }), mode),
    ).toBe('error')
  })

  test('composite any: all sub-modes passing → ok', () => {
    const mode: FailureMode = {
      kind: 'composite',
      logic: 'any',
      modes: [{ kind: 'turn-error' }, { kind: 'pre-run-exit' }],
    }
    expect(classifyFireResult(inputs(), mode)).toBe('ok')
  })

  test('composite all: needs every sub-mode to fail', () => {
    const mode: FailureMode = {
      kind: 'composite',
      logic: 'all',
      modes: [
        { kind: 'turn-error' },
        { kind: 'output-regex', pattern: 'oops' },
      ],
    }
    // Only turn error — output clean → not all fail → ok
    expect(
      classifyFireResult(inputs({ turnReason: 'error', output: 'clean' }), mode),
    ).toBe('ok')
    // Both conditions met → error
    expect(
      classifyFireResult(inputs({ turnReason: 'error', output: 'oops' }), mode),
    ).toBe('error')
  })
})

describe('extractRunnerOutputText', () => {
  test('string payload → string', () => {
    expect(extractRunnerOutputText('hello')).toBe('hello')
  })

  test('result message → .result field', () => {
    expect(extractRunnerOutputText({ type: 'result', result: 'done' })).toBe(
      'done',
    )
  })

  test('assistant message with text content blocks', () => {
    expect(
      extractRunnerOutputText({
        message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      }),
    ).toBe('hello world')
  })

  test('message.content as string', () => {
    expect(
      extractRunnerOutputText({ message: { content: 'inline' } }),
    ).toBe('inline')
  })

  test('plain text chunk', () => {
    expect(extractRunnerOutputText({ text: 'raw' })).toBe('raw')
  })

  test('unknown shape → empty string', () => {
    expect(extractRunnerOutputText({})).toBe('')
    expect(extractRunnerOutputText(null)).toBe('')
    expect(extractRunnerOutputText(42)).toBe('')
  })
})

describe('computeBackoffMs', () => {
  test('attempt 1 returns base', () => {
    expect(computeBackoffMs(1000, 1)).toBe(1000)
  })

  test('attempt 2 returns 2x base', () => {
    expect(computeBackoffMs(1000, 2)).toBe(2000)
  })

  test('attempt 3 returns 4x base', () => {
    expect(computeBackoffMs(1000, 3)).toBe(4000)
  })

  test('caps at 1 hour', () => {
    expect(computeBackoffMs(60 * 60 * 1000, 10)).toBe(60 * 60 * 1000)
    expect(computeBackoffMs(10 * 60 * 1000, 10)).toBe(60 * 60 * 1000)
  })
})
