import { useEffect, useState } from 'react'
import { api, ApiError, type WebCronTask } from '../../../api/client'
import { useCronStore } from '../../../store/cronStore'
import { useWsClient } from '../../../hooks/useWsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RotateCw, Pause, Play, Trash2, Plus } from 'lucide-react'

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

  useEffect(() => { void refresh() }, [projectId])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (f.type === 'cron.tasksChanged' && (f as { projectId?: string }).projectId === projectId) {
        void refresh()
      }
    })
  }, [ws, projectId])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">
          Cron Tasks ({tasks.length})
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void refresh()}>
          <RotateCw className="h-3 w-3" />
        </Button>
      </div>
      {error && <div className="text-destructive text-xs">⚠ {error}</div>}
      {loading && tasks.length === 0 && <div className="text-muted-foreground text-xs">載入中…</div>}
      {!loading && tasks.length === 0 && !error && (
        <div className="text-muted-foreground text-xs">尚無排程任務。下方可新增。</div>
      )}
      <div className="flex flex-col gap-1.5">
        {tasks.map(t => <CronRow key={t.id} task={t} projectId={projectId} />)}
      </div>
      <CronCreateInline projectId={projectId} onCreated={() => void refresh()} />
    </div>
  )
}

function CronRow({ task, projectId }: { task: WebCronTask; projectId: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const isPaused = task.state === 'paused'
  const isCompleted = task.state === 'completed'
  const display = task.scheduleSpec?.raw ?? task.cron
  const label = task.name ?? task.prompt.split('\n')[0]

  async function pauseOrResume() {
    setBusy('toggle')
    try {
      if (isPaused) await api.cron.resume(projectId, task.id)
      else await api.cron.pause(projectId, task.id)
    } catch (e) {
      alert(`${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(null) }
  }

  async function del() {
    setBusy('delete')
    try {
      await api.cron.delete(projectId, task.id)
    } catch (e) {
      alert(`${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      setPendingDelete(false)
    }
  }

  const stateBadge = isPaused
    ? <Badge variant="outline">paused</Badge>
    : isCompleted
      ? <Badge variant="secondary">done</Badge>
      : <Badge variant="default">scheduled</Badge>

  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm">
          {stateBadge}
          <span className="flex-1 truncate" title={label}>{label}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
          <span>{display}</span>
          {task.recurring && <span>· recurring</span>}
          {task.lastStatus === 'error' && <span className="text-destructive">· last fail</span>}
        </div>
        <div className="flex gap-1 mt-1">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={pauseOrResume} className="h-7">
            {isPaused ? <><Play className="h-3 w-3 mr-1" />Resume</> : <><Pause className="h-3 w-3 mr-1" />Pause</>}
          </Button>
          <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setPendingDelete(true)} className="h-7">
            <Trash2 className="h-3 w-3 mr-1" />Delete
          </Button>
        </div>
        <AlertDialog open={pendingDelete} onOpenChange={o => { if (!o) setPendingDelete(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>刪除任務 {label}？</AlertDialogTitle>
              <AlertDialogDescription>不可復原。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => void del()} className="bg-destructive text-destructive-foreground">
                刪除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

function CronCreateInline({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [cronStr, setCronStr] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!cronStr.trim() || !prompt.trim() || busy) return
    setBusy(true); setErr(null)
    try {
      await api.cron.create(projectId, {
        cron: cronStr.trim(),
        prompt: prompt.trim(),
        recurring: true,
        name: name.trim() || undefined,
      })
      setPrompt(''); setName(''); setOpen(false); onCreated()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="self-start">
        <Plus className="h-3 w-3 mr-1" /> 新增任務
      </Button>
    )
  }
  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-2">
        <Input
          placeholder="cron（例 0 9 * * * = 每天 9:00）"
          value={cronStr}
          onChange={e => setCronStr(e.target.value)}
          className="text-xs font-mono h-8"
        />
        <Input
          placeholder="名稱（選填）"
          value={name}
          onChange={e => setName(e.target.value)}
          className="text-xs h-8"
        />
        <Textarea
          placeholder="prompt（送給 LLM 的內容）"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={3}
          className="text-xs resize-none"
        />
        {err && <div className="text-destructive text-xs">⚠ {err}</div>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>取消</Button>
          <Button size="sm" onClick={submit} disabled={busy || !cronStr.trim() || !prompt.trim()}>
            {busy ? '建立中…' : '建立'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
