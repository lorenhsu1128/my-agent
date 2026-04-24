import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  addCronTask,
  type CronTask,
  listAllCronTasks,
  parseSchedule,
  removeCronTasks,
  updateCronTask,
} from '../../utils/cronTasks.js'
import {
  enrich,
  type Enriched,
  lastRunLabel,
  nextFireLabel,
  sortEnriched,
  stateIcon,
  taskLabel,
  truncate,
} from './cronPickerLogic.js'
import { parseScheduleNL } from '../../utils/cronNlParser.js'
import {
  CronCreateWizard,
  type CronWizardDraft,
} from '../../components/CronCreateWizard.js'
import {
  getCurrentDaemonManager,
  sendCronMutationToDaemon,
} from '../../hooks/useDaemonMode.js'
import type { CronMutationPayload } from '../../repl/thinClient/fallbackManager.js'
import { readHistory, type CronHistoryEntry } from '../../utils/cronHistory.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { WORKLOAD_CRON } from '../../utils/workloadContext.js'

type Props = {
  onExit: (summary: string) => void
}

type Mode = 'list' | 'detail' | 'confirmDelete' | 'create' | 'edit' | 'history'

const HISTORY_PAGE_SIZE = 20
const HISTORY_MAX = 200

type Flash = { text: string; tone: 'info' | 'error' }

function formatTaskId(id: string): string {
  // 8 chars short id; keep as-is
  return id
}

/** Local-time display used by history rows. Zero-padded YYYY-MM-DD HH:MM:SS
 * in the user's timezone — easier to correlate with wall-clock than ISO UTC. */
function formatLocalTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function CronPicker({ onExit }: Props): React.ReactNode {
  const [mode, setMode] = useState<Mode>('list')
  const [tasks, setTasks] = useState<CronTask[]>([])
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<CronHistoryEntry[]>([])
  const [fullHistory, setFullHistory] = useState<CronHistoryEntry[]>([])
  const [historyOffset, setHistoryOffset] = useState(0)
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

  // Subscribe to daemon broadcasts — cron.tasksChanged → immediate reload
  // (avoids waiting for the 5s poll when another client mutates).
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string }) => {
      if (f.type === 'cron.tasksChanged') {
        setReloadToken(n => n + 1)
      }
    }
    mgr.on('frame', handler as never)
    return () => mgr.off('frame', handler as never)
  }, [])

  /**
   * Try daemon first (if attached); return true if daemon handled it. false
   * means caller should run the local fallback. Daemon success → flash + reload
   * handled here; daemon failure → error flash, no reload.
   */
  async function daemonMutate(
    req: CronMutationPayload,
    successText: string,
  ): Promise<'daemon-ok' | 'daemon-err' | 'not-attached'> {
    const res = await sendCronMutationToDaemon(req, 10_000)
    if (res === null) return 'not-attached'
    if (res.ok) {
      setFlash({ text: successText, tone: 'info' })
      reload()
      return 'daemon-ok'
    }
    setFlash({ text: `Daemon rejected: ${res.error}`, tone: 'error' })
    return 'daemon-err'
  }

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
    readHistory(selected.id)
      .then(h => {
        // readHistory returns everything (chronological). We only want the
        // tail of most recent fires for the inline detail panel.
        if (!cancelled) setHistory(h.slice(-5).reverse())
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [mode, selected?.id])

  // Load full history when entering history mode
  useEffect(() => {
    let cancelled = false
    if (mode !== 'history' || !selected) {
      setFullHistory([])
      setHistoryOffset(0)
      return
    }
    readHistory(selected.id)
      .then(h => {
        if (!cancelled) {
          // readHistory is chronological; show newest first, cap at
          // HISTORY_MAX most recent entries.
          const tail = h.slice(-HISTORY_MAX).reverse()
          setFullHistory(tail)
          setHistoryOffset(0)
        }
      })
      .catch(() => {
        if (!cancelled) setFullHistory([])
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
    const successText = `${nextState === 'paused' ? '⏸ Paused' : '▶ Resumed'} ${taskLabel(selected)}`
    // Try daemon first
    const op: 'pause' | 'resume' = nextState === 'paused' ? 'pause' : 'resume'
    const d = await daemonMutate({ op, id: selected.id }, successText)
    if (d !== 'not-attached') return
    // Local fallback
    try {
      await updateCronTask(selected.id, t => {
        if (nextState === 'paused') {
          return { ...t, state: 'paused', pausedAt: new Date().toISOString() }
        }
        const { pausedAt: _p, ...rest } = t
        return { ...rest, state: 'scheduled' }
      })
      setFlash({ text: successText, tone: 'info' })
      reload()
    } catch (err) {
      setFlash({ text: `Failed: ${(err as Error).message}`, tone: 'error' })
    }
  }

  function taskToDraft(t: CronTask): CronWizardDraft {
    return {
      cron: t.cron,
      prompt: t.prompt,
      name: t.name,
      recurring: t.recurring ?? false,
      retry: t.retry,
      condition: t.condition,
      catchupMax: t.catchupMax,
      notify: t.notify,
      preRunScript: t.preRunScript,
      modelOverride: t.modelOverride,
      scheduleSpec: t.scheduleSpec,
    }
  }

  async function resolveScheduleOrFlash(
    rawSchedule: string,
  ): Promise<{ cron: string; scheduleSpec: { kind: 'cron' | 'nl'; raw: string } } | null> {
    try {
      const parsed = parseSchedule(rawSchedule)
      return { cron: parsed.cron, scheduleSpec: { kind: 'cron', raw: rawSchedule } }
    } catch {
      try {
        const ctrl = new AbortController()
        const nl = await parseScheduleNL(rawSchedule, { signal: ctrl.signal })
        return { cron: nl.cron, scheduleSpec: { kind: 'nl', raw: rawSchedule } }
      } catch (err) {
        setFlash({
          text: `Schedule parse failed: ${(err as Error).message}`,
          tone: 'error',
        })
        return null
      }
    }
  }

  async function editTaskFromDraft(
    originalId: string,
    draft: CronWizardDraft,
  ): Promise<void> {
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

    const resolved = await resolveScheduleOrFlash(rawSchedule)
    if (!resolved) return

    // Try daemon first — build a full patch with clears for advanced fields
    // the user removed.
    const patch: Record<string, unknown> = {
      cron: resolved.cron,
      prompt,
      name: draft.name,
      scheduleSpec: resolved.scheduleSpec,
      recurring: draft.recurring ? true : undefined,
      retry: draft.retry,
      condition: draft.condition,
      catchupMax: draft.catchupMax,
      notify: draft.notify,
      preRunScript:
        draft.preRunScript && draft.preRunScript !== ''
          ? draft.preRunScript
          : undefined,
      modelOverride:
        draft.modelOverride && draft.modelOverride !== ''
          ? draft.modelOverride
          : undefined,
    }
    const d = await sendCronMutationToDaemon(
      { op: 'update', id: originalId, patch },
      10_000,
    )
    if (d !== null) {
      setMode('list')
      if (d.ok) {
        setFlash({ text: `✓ Updated ${originalId}`, tone: 'info' })
        reload()
      } else {
        setFlash({ text: `Daemon rejected: ${d.error}`, tone: 'error' })
      }
      return
    }

    // Local fallback
    try {
      const result = await updateCronTask(originalId, t => {
        const next: CronTask = {
          ...t,
          cron: resolved.cron,
          prompt,
          name: draft.name,
          scheduleSpec: resolved.scheduleSpec,
        }
        // Recurring toggle — preserve undefined-vs-false semantics of schema
        if (draft.recurring) {
          next.recurring = true
        } else {
          delete (next as Partial<CronTask>).recurring
        }
        // Advanced — only overwrite when user explicitly set; undefined clears.
        if (draft.retry !== undefined) {
          next.retry = draft.retry as CronTask['retry']
        } else {
          delete (next as Partial<CronTask>).retry
        }
        if (draft.condition !== undefined) {
          next.condition = draft.condition as CronTask['condition']
        } else {
          delete (next as Partial<CronTask>).condition
        }
        if (draft.catchupMax !== undefined) {
          next.catchupMax = draft.catchupMax
        } else {
          delete (next as Partial<CronTask>).catchupMax
        }
        if (draft.notify !== undefined) {
          next.notify = draft.notify as CronTask['notify']
        } else {
          delete (next as Partial<CronTask>).notify
        }
        if (draft.preRunScript !== undefined && draft.preRunScript !== '') {
          next.preRunScript = draft.preRunScript
        } else {
          delete (next as Partial<CronTask>).preRunScript
        }
        if (draft.modelOverride !== undefined && draft.modelOverride !== '') {
          next.modelOverride = draft.modelOverride
        } else {
          delete (next as Partial<CronTask>).modelOverride
        }
        return next
      })
      if (!result) {
        setFlash({ text: 'Task not found (concurrent delete?)', tone: 'error' })
      } else {
        setFlash({ text: `✓ Updated ${originalId}`, tone: 'info' })
      }
      setMode('list')
      reload()
    } catch (err) {
      setFlash({ text: `Update failed: ${(err as Error).message}`, tone: 'error' })
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
    const resolved = await resolveScheduleOrFlash(rawSchedule)
    if (!resolved) return
    // Try daemon first
    const d = await sendCronMutationToDaemon(
      {
        op: 'create',
        cron: resolved.cron,
        prompt,
        recurring: draft.recurring ?? true,
        name: draft.name,
        modelOverride: draft.modelOverride,
        preRunScript: draft.preRunScript,
        scheduleSpec: resolved.scheduleSpec,
        retry: draft.retry,
        condition: draft.condition,
        catchupMax: draft.catchupMax,
        notify: draft.notify,
      },
      10_000,
    )
    if (d !== null) {
      setMode('list')
      if (d.ok) {
        setFlash({
          text: `✓ Created ${d.taskId ?? '?'} (${resolved.cron})`,
          tone: 'info',
        })
        reload()
      } else {
        setFlash({ text: `Daemon rejected: ${d.error}`, tone: 'error' })
      }
      return
    }
    // Local fallback
    try {
      const id = await addCronTask(
        resolved.cron,
        prompt,
        draft.recurring ?? true,
        true,
        undefined,
        {
          name: draft.name,
          modelOverride: draft.modelOverride,
          preRunScript: draft.preRunScript,
          scheduleSpec: resolved.scheduleSpec,
        },
      )
      setFlash({ text: `✓ Created ${id} (${resolved.cron})`, tone: 'info' })
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
    const successText = `✗ Deleted ${taskLabel(selected)}`
    const d = await daemonMutate(
      { op: 'delete', ids: [selected.id] },
      successText,
    )
    setMode('list')
    if (d !== 'not-attached') return
    try {
      await removeCronTasks([selected.id])
      setFlash({ text: successText, tone: 'info' })
      reload()
    } catch (err) {
      setFlash({ text: `Delete failed: ${(err as Error).message}`, tone: 'error' })
    }
  }

  useInput((input, key) => {
    // In create/edit modes the wizard owns input. Do nothing here.
    if (mode === 'create' || mode === 'edit') return

    if (mode === 'history') {
      if (key.escape || key.leftArrow || input === 'q') {
        setMode('detail')
        return
      }
      if (key.upArrow) {
        setHistoryOffset(o => Math.max(0, o - 1))
        return
      }
      if (key.downArrow) {
        setHistoryOffset(o =>
          Math.min(Math.max(0, fullHistory.length - HISTORY_PAGE_SIZE), o + 1),
        )
        return
      }
      if (key.pageUp) {
        setHistoryOffset(o => Math.max(0, o - HISTORY_PAGE_SIZE))
        return
      }
      if (key.pageDown) {
        setHistoryOffset(o =>
          Math.min(
            Math.max(0, fullHistory.length - HISTORY_PAGE_SIZE),
            o + HISTORY_PAGE_SIZE,
          ),
        )
        return
      }
      return
    }

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
      if (input === 'e') {
        if (!selected) return
        setMode('edit')
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
    if (input === 'e') {
      if (!selected) return
      setMode('edit')
      return
    }
    if (input === 'H') {
      if (!selected) return
      setMode('history')
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

  if (mode === 'edit' && selected) {
    return (
      <Box flexDirection="column">
        <CronCreateWizard
          wizardId={`local-edit-${selected.id}`}
          draft={taskToDraft(selected)}
          onConfirm={draft => {
            void editTaskFromDraft(selected.id, draft)
          }}
          onCancel={() => {
            setMode('list')
            setFlash({ text: 'Edit cancelled', tone: 'info' })
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

  if (mode === 'history' && selected) {
    const total = fullHistory.length
    const page = fullHistory.slice(historyOffset, historyOffset + HISTORY_PAGE_SIZE)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box>
          <Text bold>History · {formatTaskId(selected.id)} · {taskLabel(selected)}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Showing {total === 0 ? 0 : historyOffset + 1}-
            {Math.min(total, historyOffset + HISTORY_PAGE_SIZE)} of {total}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {page.length === 0 ? (
            <Text dimColor>(no history)</Text>
          ) : (
            page.map(h => {
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
                      : h.status === 'skipped'
                        ? 'gray'
                        : undefined
              return (
                <Box key={h.ts}>
                  <Text color={color}>{mark} </Text>
                  <Text dimColor>{formatLocalTime(h.ts)} </Text>
                  <Text>
                    {typeof h.durationMs === 'number' ? `${h.durationMs}ms ` : ''}
                    att={h.attempt ?? 1}
                    {h.errorMsg ? ` err="${h.errorMsg}"` : ''}
                  </Text>
                </Box>
              )
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ scroll · PgUp/PgDn page · q/Esc/← = back to detail</Text>
        </Box>
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
                <Box width={20}>
                  {e.task.scheduleSpec?.raw &&
                  e.task.scheduleSpec.raw !== e.task.cron ? (
                    <Text color="gray">“{truncate(e.task.scheduleSpec.raw, 18)}”</Text>
                  ) : (
                    <Text> </Text>
                  )}
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
          ↑/↓ · Enter=detail · n=new · e=edit · r=run · p=pause/resume · d=delete · q/Esc=close
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
              <Text dimColor>{formatLocalTime(h.ts)} </Text>
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
        <Text dimColor>e=edit · r=run · p=pause/resume · H=full history · d=delete · q/Esc/←=back</Text>
      </Box>
    </Box>
  )
}
