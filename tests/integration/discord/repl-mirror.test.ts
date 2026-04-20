/**
 * M-DISCORD-AUTOBIND：β 鏡像策略 target picker + header formatter 單元測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  formatMirrorHeader,
  pickMirrorTarget,
} from '../../../src/discord/replMirror'

describe('pickMirrorTarget', () => {
  test('per-project binding wins', () => {
    const r = pickMirrorTarget({
      cwd: '/proj/my-agent',
      channelBindings: { CH_PROJ: '/proj/my-agent' },
      homeChannelId: 'HOME',
    })
    expect(r).toEqual({ channelId: 'CH_PROJ', kind: 'project' })
  })

  test('fallback to home when no binding', () => {
    const r = pickMirrorTarget({
      cwd: '/proj/other',
      channelBindings: { CH_OTHER: '/proj/elsewhere' },
      homeChannelId: 'HOME',
    })
    expect(r).toEqual({ channelId: 'HOME', kind: 'home' })
  })

  test('null when neither', () => {
    const r = pickMirrorTarget({
      cwd: '/x',
      channelBindings: {},
      homeChannelId: undefined,
    })
    expect(r).toBeNull()
  })

  test('multiple bindings — only exact cwd match wins', () => {
    const r = pickMirrorTarget({
      cwd: '/a',
      channelBindings: { CH_A: '/a', CH_B: '/b' },
      homeChannelId: 'H',
    })
    expect(r).toEqual({ channelId: 'CH_A', kind: 'project' })
  })
})

describe('formatMirrorHeader', () => {
  test('project + repl source → [from REPL]', () => {
    const h = formatMirrorHeader({
      kind: 'project',
      projectId: 'p',
      source: 'repl',
      durationStr: '1.2s',
      reason: 'done',
    })
    expect(h).toContain('[from REPL]')
    expect(h).toContain('1.2s')
    expect(h.startsWith('✅')).toBe(true)
  })

  test('project + cron source → [from cron]', () => {
    const h = formatMirrorHeader({
      kind: 'project',
      projectId: 'p',
      source: 'cron',
      durationStr: '5s',
      reason: 'done',
    })
    expect(h).toContain('[from cron]')
  })

  test('home channel retains projectId prefix + source word', () => {
    const h = formatMirrorHeader({
      kind: 'home',
      projectId: 'proj-12345678',
      source: 'repl',
      durationStr: '2s',
      reason: 'done',
    })
    expect(h).toContain('`proj-12345678`')
    expect(h).toContain('repl turn')
  })

  test('error reason adds error suffix', () => {
    const h = formatMirrorHeader({
      kind: 'project',
      projectId: 'p',
      source: 'repl',
      durationStr: '0.5s',
      reason: 'error',
      errorMessage: 'something broke badly',
    })
    expect(h).toContain('❌')
    expect(h).toContain('something broke')
  })

  test('cancelled → ⏹️', () => {
    const h = formatMirrorHeader({
      kind: 'home',
      projectId: 'p',
      source: 'repl',
      durationStr: '1s',
      reason: 'cancelled',
    })
    expect(h).toContain('⏹️')
  })
})
