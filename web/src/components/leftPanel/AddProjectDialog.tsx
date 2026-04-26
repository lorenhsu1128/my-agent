import { useState } from 'react'
import { Modal } from '../common/Modal'
import { api, ApiError } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'

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
    <Modal open={open} onClose={onClose} title="加入 Project">
      <div className="flex flex-col gap-3">
        <label className="text-sm text-text-secondary">
          Project 絕對路徑（cwd）
        </label>
        <input
          type="text"
          autoFocus
          value={cwd}
          onChange={e => setCwd(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="/Users/me/projects/foo  或  C:\\Users\\me\\foo"
          className="bg-bg-tertiary text-text-primary px-3 py-2 rounded border border-divider focus:border-brand outline-none"
        />
        {err && <div className="text-sm text-status-dnd">⚠ {err}</div>}
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded text-text-primary hover:bg-bg-accent disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy || !cwd.trim()}
            className="px-4 py-2 rounded bg-brand hover:bg-brand-hover text-white disabled:opacity-50"
          >
            {busy ? '載入中…' : '加入'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
