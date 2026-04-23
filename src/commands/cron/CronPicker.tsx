import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  addCronTask,
  type CronTask,
  listAllCronTasks,
  nextCronRunMs,
  parseSchedule,
  removeCronTasks,
  updateCronTask,
} from '../../utils/cronTasks.js'
import { parseScheduleNL } from '../../utils/cronNlParser.js'
import {
  CronCreateWizard,
  type CronWizardDraft,
} from '../../components/CronCreateWizard.js'
import { readHistory, type CronHistoryEntry } from '../../utils/cronHistory.js'
import { formatDuration } from '../../utils/format.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { WORKLOAD_CRON } from '../../utils/workloadContext.js'

type Props = {
  onExit: (summary: string) => void
}

type Mode = 'list' | 'detail' | 'confirmDelete' | 'create'

type Flash = { text: string; tone: 'info' | 'error' }

type Enriched = {
  task: CronTask
  nextFireMs: number | null
  stateRank: number
}

const STATE_RANK: Record<NonNullable<CronTask['state']> | 'scheduled', number> = {
  scheduled: 0,
  paused: 1,
  completed: 2,
}

function enrich(t: CronTask, nowMs: number): Enriched {
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

function sortEnriched(a: Enriched, b: Enriched): number {
  if (a.stateRank !== b.stateRank) return a.stateRank - b.stateRank
  const an = a.nextFireMs ?? Number.POSITIVE_INFINITY
  const bn = b.nextFireMs ?? Number.POSITIVE_INFINITY
  return an - bn
}

function stateIcon(t: CronTask): { icon: string; color: string } {
  const s = t.state ?? 'scheduled'
  if (s === 'paused') return { icon: '⏸', color: 'yellow' }
  if (s === 'completed') return { icon: '☑', color: 'gray' }
  if (t.lastStatus === 'error') return { icon: '✗', color: 'red' }
  return { icon: '✓', color: 'green' }
}

function taskLabel(t: CronTask): string {
  if (t.name) return t.name
  const firstLine = t.prompt.split('\n')[0] ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 37) + '...' : firstLine
}

function nextFireLabel(e: Enriched, nowMs: number): string {
  const s = e.task.state ?? 'scheduled'
  if (s === 'paused') return 'paused'
  if (s === 'completed') return 'completed'
  if (e.nextFireMs === null) return 'n/a'
  const delta = e.nextFireMs - nowMs
  if (delta <= 0) return 'overdue'
  return `in ${formatDuration(delta, { mostSignificantOnly: true })}`
}

function lastRunLabel(t: CronTask): string {
  if (!t.lastFiredAt) return 'never'
  const ago = Date.now() - t.lastFiredAt
  const dur = formatDuration(ago, { mostSignificantOnly: true })
  const mark = t.lastStatus === 'error' ? '✗' : t.lastStatus === 'ok' ? '✓' : '·'
  return `${mark} ${dur} ago`
}

function formatTaskId(id: string): string {
  // 8 chars short id; keep as-is
  return id
}

export function CronPicker({ onExit }: Props): React.ReactNode {
  const [mode, setMode] = useState<Mode>('list')
  const [tasks, setTasks] = useState<CronTask[]>([])
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<CronHistoryEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)

  // Refresh now every 10s so "in 2h 14m" counts down
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  // Reload triggered after local mutations to reflect changes instantly.
  const [reloadToken, setReloadToken] = useState(0)
  const reload = () => setReloadToken(n => n + 1)

  // Initial load + poll every 5s for external changes (daemon writes)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const list = await listAllCronTasks()
        if (!cancelled) {
          setTasks(list)
          setLoadError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError((err as Error).message)
        }
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [reloadToken])

  // Auto-clear flash after 2.5s
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  const enriched = useMemo(() => {
    return tasks.map(t => enrich(t, now)).sort(sortEnriched)
  }, [tasks, now])

  // Clamp cursor
  const clampedCursor = Math.min(Math.max(0, cursor), Math.max(0, enriched.length - 1))

  const selected = enriched[clampedCursor]?.task

  // Load history for currently-selected task when entering detail mode
  useEffect(() => {
    let cancelled = false
    if (mode !== 'detail' || !selected) {
      setHistory([])
      return
    }
    readHistory(selected.id, 5)
      .then(h => {
        if (!cancelled) setHistory(h)
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [mode, selected?.id])

  async function togglePauseSelected(): Promise<void> {
    if (!selected) return
    const currentState = selected.state ?? 'scheduled'
    if (currentState === 'completed') {
      setFlash({ text: 'Cannot pause/resume a completed task', tone: 'error' })
      return
    }
    const nextState: CronTask['state'] =
      currentState === 'paused' ? 'scheduled' : 'paused'
    try {
      await updateCronTask(selected.id, t => {
        if (nextState === 'paused') {
          return { ...t, state: 'paused', pausedAt: new Date().toISOString() }
        }
        const { pausedAt: _p, ...rest } = t
        return { ...rest, state: 'scheduled' }
      })
      setFlash({
        text: `${nextState === 'paused' ? '⏸ Paused' : '▶ Resumed'} ${taskLabel(selected)}`,
        tone: 'info',
      })
      reload()
    } catch (err) {
      setFlash({ text: `Failed: ${(err as Error).message}`, tone: 'error' })
    }
  }

  async function createTaskFromDraft(draft: CronWizardDraft): Promise<void> {
    const rawSchedule = (draft.cron ?? draft.schedule ?? '').trim()
    const prompt = (draft.prompt ?? '').trim()
    if (!rawSchedule) {
      setFlash({ text: 'Schedule is required', tone: 'error' })
      return
    }
    if (!prompt) {
      setFlash({ text: 'Prompt is required', tone: 'error' })
      return
    }

    // Resolve schedule — try local parseSchedule (5-field cron / "every Nm")
    // first; fall back to LLM NL parser.
    let cron: string
    let scheduleSpec: { kind: 'cron' | 'nl'; raw: string } | undefined
    let recurring: boolean = draft.recurring ?? true
    try {
      const parsed = parseSchedule(rawSchedule)
      cron = parsed.cron
      scheduleSpec = { kind: 'cron', raw: rawSchedule }
      // parseSchedule always returns recurring: true (interval forms are
      // always recurring). Respect user override only for one-shots, which
      // must go through NL parser or explicit 5-field crons.
      if (draft.recurring !== undefined) recurring = draft.recurring
    } catch {
      setFlash({ text: 'Resolving schedule via LLM…', tone: 'info' })
      try {
        const ctrl = new AbortController()
        const nl = await parseScheduleNL(rawSchedule, { signal: ctrl.signal })
        cron = nl.cron
        scheduleSpec = { kind: 'nl', raw: rawSchedule }
        if (draft.recurring === undefined) recurring = nl.recurring
      } catch (err) {
        setFlash({
          text: `Schedule parse failed: ${(err as Error).message}`,
          tone: 'error',
        })
        return
      }
    }

    try {
      const id = await addCronTask(cron, prompt, recurring, true, undefined, {
        name: draft.name,
        modelOverride: draft.modelOverride,
        preRunScript: draft.preRunScript,
        scheduleSpec,
      })
      setFlash({ text: `✓ Created ${id} (${cron})`, tone: 'info' })
      setMode('list')
      reload()
    } catch (err) {
      setFlash({ text: `Create failed: ${(err as Error).message}`, tone: 'error' })
    }
  }

  function runNowSelected(): void {
    if (!selected) return
    try {
      enqueuePendingNotification({
        value: selected.prompt,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        workload: WORKLOAD_CRON,
      })
      setFlash({
        text: `✓ Enqueued ${taskLabel(selected)} — will run at next turn gap`,
        tone: 'info',
      })
    } catch (err) {
      setFlash({ text: `Run-now failed: ${(err as Error).message}`, tone: 'error' })
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selected) return
    try {
      await removeCronTasks([selected.id])
      setFlash({ text: `✗ Deleted ${taskLabel(selected)}`, tone: 'info' })
      setMode('list')
      reload()
    } catch (err) {
      setFlash({ text: `Delete failed: ${(err as Error).message}`, tone: 'error' })
      setMode('list')
    }
  }

  useInput((input, key) => {
    // In create mode the wizard owns input (its own useInput). Do nothing here.
    if (mode === 'create') return

    if (mode === 'confirmDelete') {
      if (input === 'y' || input === 'Y') {
        void deleteSelected()
        return
      }
      // Any other key cancels
      setMode('list')
      return
    }

    if (mode === 'list') {
      if (key.escape || input === 'q') {
        onExit(`Cron picker closed — ${tasks.length} task(s)`)
        return
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1))
        return
      }
      if (key.downArrow) {
        setCursor(c => Math.min(enriched.length - 1, c + 1))
        return
      }
      if (key.return) {
        if (enriched.length === 0) return
        setMode('detail')
        return
      }
      if (input === 'p') {
        void togglePauseSelected()
        return
      }
      if (input === 'r') {
        runNowSelected()
        return
      }
      if (input === 'n') {
        setMode('create')
        return
      }
      if (input === 'd') {
        if (!selected) return
        setMode('confirmDelete')
        return
      }
      return
    }

    // detail mode
    if (key.escape || key.leftArrow || input === 'q') {
      setMode('list')
      return
    }
    if (input === 'p') {
      void togglePauseSelected()
      return
    }
    if (input === 'r') {
      runNowSelected()
      return
    }
    if (input === 'd') {
      if (!selected) return
      setMode('confirmDelete')
      return
    }
  })

  if (loadError !== null) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load cron tasks: {loadError}</Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    )
  }

  if (mode === 'create') {
    return (
      <Box flexDirection="column">
        <CronCreateWizard
          wizardId="local-create"
          draft={{ recurring: true }}
          onConfirm={draft => {
            void createTaskFromDraft(draft)
          }}
          onCancel={() => {
            setMode('list')
            setFlash({ text: 'Create cancelled', tone: 'info' })
          }}
        />
        {flash && (
          <Box marginTop={1}>
            <Text color={flash.tone === 'error' ? 'red' : 'green'}>{flash.text}</Text>
          </Box>
        )}
      </Box>
    )
  }

  if (mode === 'confirmDelete' && selected) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
        <Text bold color="red">Delete cron task?</Text>
        <Box marginTop={1}>
          <Text>
            {formatTaskId(selected.id)} · <Text bold>{taskLabel(selected)}</Text>
          </Text>
        </Box>
        <Box>
          <Text dimColor>Schedule: {selected.cron}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Type </Text>
          <Text bold color="red">y</Text>
          <Text> to confirm, any other key to cancel.</Text>
        </Box>
      </Box>
    )
  }

  if (mode === 'detail' && selected) {
    return (
      <Box flexDirection="column">
        <CronDetail
          task={selected}
          history={history}
          enriched={enriched[clampedCursor]!}
          now={now}
        />
        {flash && (
          <Box marginTop={1}>
            <Text color={flash.tone === 'error' ? 'red' : 'green'}>{flash.text}</Text>
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <CronList
        enriched={enriched}
        cursor={clampedCursor}
        now={now}
      />
      {flash && (
        <Box marginTop={1}>
          <Text color={flash.tone === 'error' ? 'red' : 'green'}>{flash.text}</Text>
        </Box>
      )}
    </Box>
  )
}

function CronList({
  enriched,
  cursor,
  now,
}: {
  enriched: Enriched[]
  cursor: number
  now: number
}): React.ReactNode {
  const counts = useMemo(() => {
    const c = { scheduled: 0, paused: 0, completed: 0 }
    for (const e of enriched) {
      const s = e.task.state ?? 'scheduled'
      c[s] = (c[s] ?? 0) + 1
    }
    return c
  }, [enriched])

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Cron Tasks</Text>
        <Text dimColor>
          {' '}
          · {enriched.length} total ({counts.scheduled} scheduled, {counts.paused} paused, {counts.completed} completed)
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {enriched.length === 0 ? (
          <Text dimColor>(no cron tasks)</Text>
        ) : (
          enriched.map((e, i) => {
            const selected = i === cursor
            const { icon, color } = stateIcon(e.task)
            return (
              <Box key={e.task.id}>
                <Text color={selected ? 'cyan' : undefined}>
                  {selected ? figures.pointer : ' '}
                </Text>
                <Text color={color}> {icon} </Text>
                <Box width={10}>
                  <Text dimColor>{formatTaskId(e.task.id)}</Text>
                </Box>
                <Box width={28}>
                  <Text color={selected ? 'cyan' : undefined}>
                    {taskLabel(e.task)}
                  </Text>
                </Box>
                <Box width={18}>
                  <Text dimColor>{e.task.cron}</Text>
                </Box>
                <Box width={16}>
                  <Text>{nextFireLabel(e, now)}</Text>
                </Box>
                <Text dimColor>{lastRunLabel(e.task)}</Text>
              </Box>
            )
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ move · Enter = detail · n = new · r = run · p = pause/resume · d = delete · q/Esc = close
        </Text>
      </Box>
    </Box>
  )
}

function CronDetail({
  task,
  history,
  enriched,
  now,
}: {
  task: CronTask
  history: CronHistoryEntry[]
  enriched: Enriched
  now: number
}): React.ReactNode {
  const { icon, color } = stateIcon(task)
  const state = task.state ?? 'scheduled'

  const row = (label: string, value: React.ReactNode): React.ReactNode => (
    <Box key={label}>
      <Box width={14}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold>{formatTaskId(task.id)}</Text>
        <Text> · </Text>
        <Text>{taskLabel(task)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {row('Schedule', task.cron)}
        {task.scheduleSpec?.raw
          ? row('  raw', task.scheduleSpec.raw)
          : null}
        {row(
          'State',
          `${state}${state === 'scheduled' ? ` · next ${nextFireLabel(enriched, now)}` : ''}`,
        )}
        {row(
          'Recurring',
          task.recurring
            ? task.repeat
              ? `yes · ${task.repeat.completed}/${task.repeat.times ?? '∞'}`
              : 'yes'
            : 'no (one-shot)',
        )}
        {row('Last run', lastRunLabel(task))}
        {task.lastError
          ? row('Last error', <Text color="red">{task.lastError}</Text>)
          : null}
        {row('Prompt', task.prompt)}
        {task.retry ? row('Retry', JSON.stringify(task.retry)) : null}
        {task.condition ? row('Condition', JSON.stringify(task.condition)) : null}
        {task.catchupMax !== undefined
          ? row('Catch-up max', String(task.catchupMax))
          : null}
        {task.preRunScript ? row('Pre-run', task.preRunScript) : null}
        {task.modelOverride ? row('Model', task.modelOverride) : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>── History (last {history.length}) ──</Text>
      </Box>
      {history.length === 0 ? (
        <Text dimColor>(no history)</Text>
      ) : (
        history.map(h => {
          const mark =
            h.status === 'error'
              ? '✗'
              : h.status === 'ok'
                ? '✓'
                : h.status === 'retrying'
                  ? '↻'
                  : h.status === 'skipped'
                    ? '↷'
                    : '·'
          const color =
            h.status === 'error'
              ? 'red'
              : h.status === 'ok'
                ? 'green'
                : h.status === 'retrying'
                  ? 'yellow'
                  : undefined
          return (
            <Box key={h.ts}>
              <Text color={color}>{mark} </Text>
              <Text dimColor>{new Date(h.ts).toISOString()} </Text>
              <Text>
                {typeof h.durationMs === 'number' ? `${h.durationMs}ms ` : ''}
                att={h.attempt ?? 1}
                {h.errorMsg ? ` err="${h.errorMsg}"` : ''}
              </Text>
            </Box>
          )
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>r = run now · p = pause/resume · d = delete · q/Esc/← = back</Text>
      </Box>
    </Box>
  )
}
