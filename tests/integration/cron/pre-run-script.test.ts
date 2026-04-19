import { describe, expect, test } from 'bun:test'
import {
  augmentPromptWithPreRun,
  runPreRunScript,
} from '../../../src/utils/cronPreRunScript'

const IS_WIN = process.platform === 'win32'

describe('runPreRunScript — Wave 2', () => {
  test('captures stdout from a simple command', async () => {
    const cmd = IS_WIN ? 'echo hello-cron' : 'printf hello-cron'
    const r = await runPreRunScript(cmd)
    expect(r.ok).toBe(true)
    expect(r.stdout).toContain('hello-cron')
  })

  test('reports failure on non-zero exit', async () => {
    const cmd = IS_WIN ? 'cmd /c exit 7' : 'exit 7'
    const r = await runPreRunScript(cmd)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exit code/i)
  })

  test('redacts secrets in stdout', async () => {
    // Emit a fake API key and confirm redactSecrets kicked in.
    const cmd = IS_WIN
      ? 'echo token=sk-ant-api03-abcdef1234567890'
      : 'printf token=sk-ant-api03-abcdef1234567890'
    const r = await runPreRunScript(cmd)
    expect(r.ok).toBe(true)
    expect(r.stdout).not.toContain('sk-ant-api03-abcdef1234567890')
    expect(r.stdout).toMatch(/sk-ant\.\.\./)
  })
})

describe('augmentPromptWithPreRun', () => {
  test('prepends context block when stdout non-empty', () => {
    const merged = augmentPromptWithPreRun('do the thing', {
      ok: true,
      stdout: 'some context',
    })
    expect(merged).toContain('## Context')
    expect(merged).toContain('some context')
    expect(merged.endsWith('do the thing')).toBe(true)
  })

  test('returns prompt unchanged when stdout empty', () => {
    expect(augmentPromptWithPreRun('original', { ok: true, stdout: '' })).toBe(
      'original',
    )
    expect(
      augmentPromptWithPreRun('original', { ok: true, stdout: '   ' }),
    ).toBe('original')
  })

  test('failed script still surfaces partial stdout with error header', () => {
    const merged = augmentPromptWithPreRun('after', {
      ok: false,
      stdout: 'partial',
      error: 'timed out after 10000ms',
    })
    expect(merged).toContain('preRunScript failed')
    expect(merged).toContain('partial')
  })

  test('uses a fence longer than any backtick run in stdout', () => {
    const merged = augmentPromptWithPreRun('tail', {
      ok: true,
      stdout: 'has ``` triple backticks inside',
    })
    // Must contain a fence of 4+ backticks so the inner ``` does not close
    // the fence prematurely.
    expect(merged).toMatch(/````+/)
  })
})
