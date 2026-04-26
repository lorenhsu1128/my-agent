import { useEffect, useState } from 'react'
import { api, ApiError, type WebMemoryEntry } from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'
import { MemoryEditWizard } from './MemoryEditWizard'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { RotateCw, Plus, Eye, Pencil, Trash2 } from 'lucide-react'

export interface MemoryTabProps {
  projectId: string
}

const KIND_LABEL: Record<WebMemoryEntry['kind'], string> = {
  'auto-memory': 'AUTO',
  'user-profile': 'USER',
  'project-memory': 'PROJECT',
  'local-config': 'LOCAL',
  'daily-log': 'LOG',
}

export function MemoryTab({ projectId }: MemoryTabProps) {
  const [entries, setEntries] = useState<WebMemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<WebMemoryEntry | null>(null)
  const [body, setBody] = useState<string>('')
  const [editing, setEditing] = useState<WebMemoryEntry | null>(null)
  const [editBody, setEditBody] = useState<string>('')
  const [creating, setCreating] = useState<'auto-memory' | 'local-config' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WebMemoryEntry | null>(null)
  const ws = useWsClient()

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const { entries: list } = await api.memory.list(projectId)
      setEntries(list)
    } catch (e) {
      setError(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    } finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [projectId])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (f.type === 'memory.itemsChanged' && (f as { projectId?: string }).projectId === projectId) {
        void refresh()
      }
    })
  }, [ws, projectId])

  async function viewBody(entry: WebMemoryEntry) {
    setViewing(entry); setBody('')
    try {
      const { body: text } = await api.memory.body(projectId, entry.absolutePath)
      setBody(text)
    } catch (e) {
      setBody(`(read error: ${e instanceof Error ? e.message : String(e)})`)
    }
  }

  async function startEdit(entry: WebMemoryEntry) {
    setEditing(entry); setEditBody('')
    try {
      const { body: text } = await api.memory.body(projectId, entry.absolutePath)
      setEditBody(text)
    } catch (e) {
      alert(`讀取失敗：${e instanceof Error ? e.message : String(e)}`)
      setEditing(null)
    }
  }

  async function del(entry: WebMemoryEntry) {
    try {
      await api.memory.delete(projectId, {
        kind: entry.kind,
        absolutePath: entry.absolutePath,
        filename: entry.filename,
      })
    } catch (e) {
      alert(`刪除失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPendingDelete(null)
    }
  }

  const groups: Record<string, WebMemoryEntry[]> = {}
  for (const e of entries) (groups[e.kind] ??= []).push(e)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">
          Memory ({entries.length})
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setCreating('auto-memory')}>
            <Plus className="h-3 w-3 mr-1" />AUTO
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setCreating('local-config')}>
            <Plus className="h-3 w-3 mr-1" />LOCAL
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void refresh()}>
            <RotateCw className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {error && <div className="text-destructive text-xs">⚠ {error}</div>}
      {loading && entries.length === 0 && <div className="text-muted-foreground text-xs">載入中…</div>}
      {!loading && entries.length === 0 && !error && (
        <div className="text-muted-foreground text-xs">無 memory entries</div>
      )}
      {Object.entries(groups).map(([kind, list]) => (
        <div key={kind} className="flex flex-col gap-1.5">
          <h4 className="text-[10px] uppercase text-muted-foreground">
            {KIND_LABEL[kind as WebMemoryEntry['kind']] ?? kind} ({list.length})
          </h4>
          {list.map(e => (
            <Card key={e.absolutePath}>
              <CardContent className="p-2 flex flex-col gap-0.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" title={e.displayName}>{e.displayName}</span>
                  <span className="text-muted-foreground text-[10px] flex-shrink-0">
                    {(e.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="text-muted-foreground text-xs truncate" title={e.description}>
                  {e.description || '(無描述)'}
                </div>
                <div className="flex gap-1 mt-1">
                  <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => viewBody(e)}>
                    <Eye className="h-3 w-3 mr-1" />View
                  </Button>
                  {e.kind !== 'daily-log' && (
                    <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => void startEdit(e)}>
                      <Pencil className="h-3 w-3 mr-1" />Edit
                    </Button>
                  )}
                  {(e.kind === 'auto-memory' || e.kind === 'local-config') && (
                    <Button size="sm" variant="destructive" className="h-6 px-2" onClick={() => setPendingDelete(e)}>
                      <Trash2 className="h-3 w-3 mr-1" />Delete
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ))}

      <Dialog open={!!viewing} onOpenChange={o => { if (!o) setViewing(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.displayName ?? ''}</DialogTitle>
          </DialogHeader>
          <pre className="bg-muted text-foreground text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-[60vh] font-mono">
            {body || '（載入中…）'}
          </pre>
        </DialogContent>
      </Dialog>

      <MemoryEditWizard
        projectId={projectId}
        entry={editing}
        initialBody={editBody}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => void refresh()}
      />
      <MemoryEditWizard
        projectId={projectId}
        entry={null}
        createKind={creating ?? 'auto-memory'}
        open={!!creating}
        onClose={() => setCreating(null)}
        onSaved={() => void refresh()}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={o => { if (!o) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刪除 {pendingDelete?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>軟刪除到 .trash/，可從 TUI 還原。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && void del(pendingDelete)}
              className="bg-destructive text-destructive-foreground"
            >
              刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
