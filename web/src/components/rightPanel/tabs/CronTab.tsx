import { useEffect, useState } from 'react'
import { api, ApiError, type WebCronTask } from '../../../api/client'
import { useCronStore } from '../../../store/cronStore'
import { useWsClient } from '../../../hooks/useWsClient'

export interface CronTabProps {
  projectId: string
}

export function CronTab({ projectId }: CronTabProps) {
  const tasks = useCronStore(s => s.byProject[projectId] ?? [])
  const loading = useCronStore(s => s.loadingByProject[projectId] ?? false)
  const error = useCronStore(s => s.errorByProject[projectId] ?? null)
  const ws = useWsClient()

  async function refresh(): Promise<void> {
    useCronStore.getState().setLoading(projectId, true)
    try {
      const { tasks: list } = await api.cron.list(projectId)
      useCronStore.getState().setTasks(projectId, list)
    } catch (err) {
      useCronStore
        .getState()
        .setError(
          projectId,
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
        )
    }
  }

  useEffect(() => {
    void refresh()
  }, [projectId])

  // WS 訂閱 cron.tasksChanged → 自動 refresh
  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (
        f.type === 'cron.tasksChanged' &&
        (f as { projectId?: string }).projectId === projectId
      ) {
        void refresh()
      }
    })
  }, [ws, projectId])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Cron Tasks ({tasks.length})
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-muted hover:text-text-primary text-xs"
        >
          ⟳
        </button>
      </div>
      {error && <div className="text-status-dnd text-xs">⚠ {error}</div>}
      {loading && tasks.length === 0 && (
        <div className="text-text-muted text-xs">載入中…</div>
      )}
      {!loading && tasks.length === 0 && !error && (
        <div className="text-text-muted text-xs">
          尚無排程任務。下方可新增。
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {tasks.map(t => (
          <CronRow key={t.id} task={t} projectId={projectId} />
        ))}
      </ul>
      <CronCreateInline projectId={projectId} onCreated={() => void refresh()} />
    </div>
  )
}

function CronRow({
  task,
  projectId,
}: {
  task: WebCronTask
  projectId: string
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const isPaused = task.state === 'paused'
  const display = task.scheduleSpec?.raw ?? task.cron
  const label = task.name ?? task.prompt.split('\n')[0]

  async function pauseOrResume() {
    setBusy('toggle')
    try {
      if (isPaused) await api.cron.resume(projectId, task.id)
      else await api.cron.pause(projectId, task.id)
    } catch (e) {
      alert(`${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function del() {
    if (!confirm(`刪除任務 ${label}？`)) return
    setBusy('delete')
    try {
      await api.cron.delete(projectId, task.id)
    } catch (e) {
      alert(`${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="flex flex-col gap-0.5 px-2 py-1.5 rounded bg-bg-tertiary border border-divider/50">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={[
            'text-xs w-2 h-2 rounded-full',
            isPaused
              ? 'bg-status-idle'
              : task.state === 'completed'
                ? 'bg-text-muted'
                : 'bg-status-online',
          ].join(' ')}
        />
        <span className="flex-1 truncate" title={label}>
          {label}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted font-mono">
        <span>{display}</span>
        {task.recurring && <span>· recurring</span>}
        {task.lastStatus === 'error' && (
          <span className="text-status-dnd">· last fail</span>
        )}
      </div>
      <div className="flex gap-1 mt-1">
        <button
          onClick={pauseOrResume}
          disabled={!!busy}
          className="text-xs px-2 py-0.5 rounded bg-bg-accent hover:bg-bg-floating text-text-secondary disabled:opacity-50"
        >
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={del}
          disabled={!!busy}
          className="text-xs px-2 py-0.5 rounded bg-status-dnd/40 hover:bg-status-dnd/60 text-text-primary disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </li>
  )
}

function CronCreateInline({
  projectId,
  onCreated,
}: {
  projectId: string
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [cronStr, setCronStr] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!cronStr.trim() || !prompt.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.cron.create(projectId, {
        cron: cronStr.trim(),
        prompt: prompt.trim(),
        recurring: true,
        name: name.trim() || undefined,
      })
      setPrompt('')
      setName('')
      setOpen(false)
      onCreated()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-brand hover:underline self-start"
      >
        + 新增任務
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-2 bg-bg-tertiary rounded p-2 border border-divider">
      <input
        type="text"
        placeholder="cron（例 0 9 * * * = 每天 9:00）"
        value={cronStr}
        onChange={e => setCronStr(e.target.value)}
        className="bg-bg-floating text-text-primary px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs font-mono"
      />
      <input
        type="text"
        placeholder="名稱（選填）"
        value={name}
        onChange={e => setName(e.target.value)}
        className="bg-bg-floating text-text-primary px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs"
      />
      <textarea
        placeholder="prompt（送給 LLM 的內容）"
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        rows={3}
        className="bg-bg-floating text-text-primary px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs resize-none"
      />
      {err && <div className="text-status-dnd text-xs">⚠ {err}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded text-text-secondary hover:bg-bg-accent disabled:opacity-50"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={busy || !cronStr.trim() || !prompt.trim()}
          className="text-xs px-2 py-1 rounded bg-brand hover:bg-brand-hover text-white disabled:opacity-50"
        >
          {busy ? '建立中…' : '建立'}
        </button>
      </div>
    </div>
  )
}
