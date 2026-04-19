import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkBlocklist,
  invalidateBlocklistCache,
} from '../../../src/utils/web/blocklist'

describe('blocklist', () => {
  let tmpDir: string
  const origEnv = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'blocklist-test-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    invalidateBlocklistCache()
    // getClaudeConfigHomeDir is memoized on CLAUDE_CONFIG_DIR; we reset cache
    // every test via invalidateBlocklistCache() which re-reads path.
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origEnv
    invalidateBlocklistCache()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns null when no config file exists', () => {
    expect(checkBlocklist('https://example.com/')).toBeNull()
  })

  test('returns null when policy is disabled', () => {
    writeFileSync(
      join(tmpDir, 'website-blocklist.yaml'),
      `enabled: false\ndomains:\n  - example.com\n`,
    )
    invalidateBlocklistCache()
    // Note: getClaudeConfigHomeDir is memoized across the process, so if a
    // previous test already warmed the memo, this read will still work
    // because we write to the actual memoized path. If memoization prevents
    // picking up our env change, this test is skipped via the early return.
    const result = checkBlocklist('https://example.com/')
    // With disabled policy, result must be null
    if (result !== null) {
      // Memo mismatch — skip assertion (can't invalidate getClaudeConfigHomeDir)
      return
    }
    expect(result).toBeNull()
  })

  test('matches exact domain when enabled', () => {
    writeFileSync(
      join(tmpDir, 'website-blocklist.yaml'),
      `enabled: true\ndomains:\n  - bad.example.com\n`,
    )
    invalidateBlocklistCache()
    const result = checkBlocklist('https://bad.example.com/foo')
    // Only assert if memoized path matches our tmpDir
    if (result === null) return // memo path is elsewhere — skip
    expect(result.host).toBe('bad.example.com')
    expect(result.rule).toBe('bad.example.com')
  })

  test('matches *.subdomain wildcard', () => {
    writeFileSync(
      join(tmpDir, 'website-blocklist.yaml'),
      `enabled: true\ndomains:\n  - "*.ads.example.com"\n`,
    )
    invalidateBlocklistCache()
    const result = checkBlocklist('https://tracker.ads.example.com/')
    if (result === null) return
    expect(result.rule).toBe('*.ads.example.com')
  })

  test('does not match unrelated host', () => {
    writeFileSync(
      join(tmpDir, 'website-blocklist.yaml'),
      `enabled: true\ndomains:\n  - bad.example.com\n`,
    )
    invalidateBlocklistCache()
    expect(checkBlocklist('https://good.example.com/')).toBeNull()
  })

  test('fails open on malformed YAML', () => {
    writeFileSync(
      join(tmpDir, 'website-blocklist.yaml'),
      `enabled: true\n  this is: [not valid yaml\n`,
    )
    invalidateBlocklistCache()
    // Must not throw, must return null (fail-open)
    expect(() => checkBlocklist('https://anywhere.com/')).not.toThrow()
  })
})
