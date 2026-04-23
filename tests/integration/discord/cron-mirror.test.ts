import { describe, expect, test } from 'bun:test'
import {
  formatCronMirrorMessage,
  pickCronMirrorTargets,
  resolveCronNotifyMode,
  type CronMirrorEvent,
} from '../../../src/discord/cronMirror'

const baseEvent = (over: Partial<CronMirrorEvent> = {}): CronMirrorEvent => ({
  type: 'cronFireEvent',
  taskId: 'task001',
  taskName: 'my-task',
  schedule: '*/5 * * * *',
  status: 'completed',
  startedAt: Date.now(),
  source: 'cron',
  ...over,
})

describe('cronMirror — pickCronMirrorTargets', () => {
  test('notify=off returns empty', () => {
    expect(
      pickCronMirrorTargets({
        notify: 'off',
        cwd: '/p',
        channelBindings: {},
        homeChannelId: 'home',
      }),
    ).toEqual([])
  })

  test('notify=undefined returns empty (default off)', () => {
    expect(
      pickCronMirrorTargets({
        notify: undefined,
        cwd: '/p',
        channelBindings: {},
        homeChannelId: 'home',
      }),
    ).toEqual([])
  })

  test('notify=home → home channel even with project bindings', () => {
    const r = pickCronMirrorTargets({
      notify: 'home',
      cwd: '/p',
      channelBindings: { 'proj-ch': '/p' },
      homeChannelId: 'home-ch',
    })
    expect(r).toEqual([{ channelId: 'home-ch', kind: 'home' }])
  })

  test('notify=home but no homeChannelId → empty', () => {
    const r = pickCronMirrorTargets({
      notify: 'home',
      cwd: '/p',
      channelBindings: {},
      homeChannelId: undefined,
    })
    expect(r).toEqual([])
  })

  test('notify=project binds → project channel', () => {
    const r = pickCronMirrorTargets({
      notify: 'project',
      cwd: '/p',
      channelBindings: { 'proj-ch': '/p' },
      homeChannelId: 'home-ch',
    })
    expect(r).toEqual([{ channelId: 'proj-ch', kind: 'project' }])
  })

  test('notify=project no binding → falls back to home', () => {
    const r = pickCronMirrorTargets({
      notify: 'project',
      cwd: '/other',
      channelBindings: { 'proj-ch': '/p' },
      homeChannelId: 'home-ch',
    })
    expect(r).toEqual([{ channelId: 'home-ch', kind: 'home' }])
  })
})

describe('cronMirror — formatCronMirrorMessage', () => {
  test('completed has ✅ + schedule + duration', () => {
    const msgs = formatCronMirrorMessage(
      baseEvent({ durationMs: 4200, attempt: 1 }),
    )
    const s = msgs.join('\n')
    expect(s).toContain('✅')
    expect(s).toContain('my-task')
    expect(s).toContain('completed')
    expect(s).toContain('`*/5 * * * *`')
    expect(s).toContain('4.2s')
  })

  test('failed includes errorMsg in code block, redacts secrets', () => {
    const msgs = formatCronMirrorMessage(
      baseEvent({
        status: 'failed',
        errorMsg: 'sk-ant-api01-abcdefghijk',
      }),
    )
    const s = msgs.join('\n')
    expect(s).toContain('❌')
    expect(s).toContain('```')
    expect(s).not.toContain('sk-ant-api01-abcdefghijk')
  })

  test('skipped includes skipReason', () => {
    const msgs = formatCronMirrorMessage(
      baseEvent({
        status: 'skipped',
        skipReason: 'first-fire-no-prior-error',
      }),
    )
    expect(msgs.join('\n')).toContain('first-fire-no-prior-error')
  })

  test('retrying shows attempt number', () => {
    const msgs = formatCronMirrorMessage(
      baseEvent({ status: 'retrying', attempt: 2, durationMs: 1000 }),
    )
    expect(msgs.join('\n')).toContain('att 2')
    expect(msgs.join('\n')).toContain('🔁')
  })
})

describe('cronMirror — resolveCronNotifyMode', () => {
  test('undefined task.notify → default', () => {
    expect(resolveCronNotifyMode(undefined)).toBe('off')
    expect(resolveCronNotifyMode(undefined, 'home')).toBe('home')
  })

  test('task.notify.discord wins over default', () => {
    expect(
      resolveCronNotifyMode({ discord: 'project' }, 'off'),
    ).toBe('project')
  })

  test('task.notify without discord key falls back to default', () => {
    expect(resolveCronNotifyMode({}, 'home')).toBe('home')
  })
})
