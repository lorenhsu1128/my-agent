// Pure helper functions extracted from CronPicker.tsx so they're easy to
// unit-test without an Ink harness. The picker itself remains the only
// consumer — keep this module internal (no re-exports outside /commands/cron).

import { type CronTask, nextCronRunMs } from '../../utils/cronTasks.js'
import { formatDuration } from '../../utils/format.js'

export type Enriched = {
  task: CronTask
  nextFireMs: number | null
  stateRank: number
}

const STATE_RANK: Record<NonNullable<CronTask['state']> | 'scheduled', number> = {
  scheduled: 0,
  paused: 1,
  completed: 2,
}

export function enrich(t: CronTask, nowMs: number): Enriched {
  const state = t.state ?? 'scheduled'
  const next =
    state === 'scheduled'
      ? nextCronRunMs(t.cron, Math.max(nowMs, t.lastFiredAt ?? 0))
      : null
  return {
    task: t,
    nextFireMs: next,
    stateRank: STATE_RANK[state] ?? 99,
  }
}

export function sortEnriched(a: Enriched, b: Enriched): number {
  if (a.stateRank !== b.stateRank) return a.stateRank - b.stateRank
  const an = a.nextFireMs ?? Number.POSITIVE_INFINITY
  const bn = b.nextFireMs ?? Number.POSITIVE_INFINITY
  return an - bn
}

export function stateIcon(t: CronTask): { icon: string; color: string } {
  const s = t.state ?? 'scheduled'
  if (s === 'paused') return { icon: '⏸', color: 'yellow' }
  if (s === 'completed') return { icon: '☑', color: 'gray' }
  if (t.lastStatus === 'error') return { icon: '✗', color: 'red' }
  return { icon: '✓', color: 'green' }
}

export function taskLabel(t: CronTask): string {
  if (t.name) return t.name
  const firstLine = t.prompt.split('\n')[0] ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 37) + '...' : firstLine
}

export function nextFireLabel(e: Enriched, nowMs: number): string {
  const s = e.task.state ?? 'scheduled'
  if (s === 'paused') return 'paused'
  if (s === 'completed') return 'completed'
  if (e.nextFireMs === null) return 'n/a'
  const delta = e.nextFireMs - nowMs
  if (delta <= 0) return 'overdue'
  return `in ${formatDuration(delta, { mostSignificantOnly: true })}`
}

export function lastRunLabel(t: CronTask, nowMs: number = Date.now()): string {
  if (!t.lastFiredAt) return 'never'
  const ago = nowMs - t.lastFiredAt
  const dur = formatDuration(ago, { mostSignificantOnly: true })
  const mark = t.lastStatus === 'error' ? '✗' : t.lastStatus === 'ok' ? '✓' : '·'
  return `${mark} ${dur} ago`
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars - 1) + '…'
}
