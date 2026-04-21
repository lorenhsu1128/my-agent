/**
 * M-DISCORD-AUTOBIND：β 鏡像策略 target picker + header formatter 單元測試。
 */
import { describe, expect, test } from 'bun:test'
import {
  formatMirrorHeader,
  pickAllMirrorTargets,
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

describe('pickAllMirrorTargets', () => {
  test('fan-out：同 cwd 綁多 channel 都回傳', () => {
    const r = pickAllMirrorTargets({
      cwd: '/proj/x',
      channelBindings: { CH_MINE: '/proj/x', CH_OTHER: '/proj/x', CH_Y: '/proj/y' },
      homeChannelId: 'HOME',
    })
    expect(r).toHaveLength(2)
    expect(r.map(t => t.channelId).sort()).toEqual(['CH_MINE', 'CH_OTHER'])
    expect(r.every(t => t.kind === 'project')).toBe(true)
  })

  test('有 per-project binding 時不回 home', () => {
    const r = pickAllMirrorTargets({
      cwd: '/proj/x',
      channelBindings: { CH_MINE: '/proj/x' },
      homeChannelId: 'HOME',
    })
    expect(r).toEqual([{ channelId: 'CH_MINE', kind: 'project' }])
  })

  test('全無 binding → fallback home 一個', () => {
    const r = pickAllMirrorTargets({
      cwd: '/proj/x',
      channelBindings: {},
      homeChannelId: 'HOME',
    })
    expect(r).toEqual([{ channelId: 'HOME', kind: 'home' }])
  })

  test('什麼都沒 → 空陣列', () => {
    const r = pickAllMirrorTargets({
      cwd: '/x',
      channelBindings: {},
      homeChannelId: undefined,
    })
    expect(r).toEqual([])
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
