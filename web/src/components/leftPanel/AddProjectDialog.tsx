import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface AddProjectDialogProps {
  open: boolean
  onClose: () => void
}

export function AddProjectDialog({ open, onClose }: AddProjectDialogProps) {
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!cwd.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      const { project } = await api.loadProject(cwd.trim())
      useProjectStore.getState().upsertProject(project)
      useProjectStore.getState().selectProject(project.projectId)
      setCwd('')
      onClose()
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

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>加入 Project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label htmlFor="cwd-input">Project 絕對路徑（cwd）</Label>
          <Input
            id="cwd-input"
            autoFocus
            value={cwd}
            onChange={e => setCwd(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') onClose()
            }}
            placeholder="/Users/me/projects/foo  或  C:\Users\me\foo"
            className="font-mono text-sm"
          />
          {err && <div className="text-sm text-destructive">⚠ {err}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={submit} disabled={busy || !cwd.trim()}>
            {busy ? '載入中…' : '加入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
