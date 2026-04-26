import { useEffect, useState } from 'react'
import { api, ApiError, type WebMemoryEntry } from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'
import { Modal } from '../../common/Modal'

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
  const ws = useWsClient()

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const { entries: list } = await api.memory.list(projectId)
      setEntries(list)
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [projectId])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (
        f.type === 'memory.itemsChanged' &&
        (f as { projectId?: string }).projectId === projectId
      ) {
        void refresh()
      }
    })
  }, [ws, projectId])

  async function viewBody(entry: WebMemoryEntry) {
    setViewing(entry)
    setBody('')
    try {
      const { body: text } = await api.memory.body(projectId, entry.absolutePath)
      setBody(text)
    } catch (e) {
      setBody(`(read error: ${e instanceof Error ? e.message : String(e)})`)
    }
  }

  async function del(entry: WebMemoryEntry) {
    if (!confirm(`刪除 ${entry.displayName}？（軟刪除到 .trash/）`)) return
    try {
      await api.memory.delete(projectId, {
        kind: entry.kind,
        absolutePath: entry.absolutePath,
        filename: entry.filename,
      })
    } catch (e) {
      alert(`刪除失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Group by kind
  const groups: Record<string, WebMemoryEntry[]> = {}
  for (const e of entries) {
    ;(groups[e.kind] ??= []).push(e)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Memory ({entries.length})
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-muted hover:text-text-primary text-xs"
        >
          ⟳
        </button>
      </div>
      {error && <div className="text-status-dnd text-xs">⚠ {error}</div>}
      {loading && entries.length === 0 && (
        <div className="text-text-muted text-xs">載入中…</div>
      )}
      {!loading && entries.length === 0 && !error && (
        <div className="text-text-muted text-xs">無 memory entries</div>
      )}
      {Object.entries(groups).map(([kind, list]) => (
        <div key={kind} className="flex flex-col gap-1">
          <h4 className="text-[10px] uppercase text-text-muted">
            {KIND_LABEL[kind as WebMemoryEntry['kind']] ?? kind} ({list.length})
          </h4>
          {list.map(e => (
            <div
              key={e.absolutePath}
              className="flex flex-col gap-0.5 px-2 py-1.5 rounded bg-bg-tertiary border border-divider/50 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" title={e.displayName}>
                  {e.displayName}
                </span>
                <span className="text-text-muted text-[10px] flex-shrink-0">
                  {(e.sizeBytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <div
                className="text-text-muted text-xs truncate"
                title={e.description}
              >
                {e.description || '(無描述)'}
              </div>
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => viewBody(e)}
                  className="text-xs px-2 py-0.5 rounded bg-bg-accent hover:bg-bg-floating text-text-secondary"
                >
                  View
                </button>
                {(e.kind === 'auto-memory' || e.kind === 'local-config') && (
                  <button
                    onClick={() => del(e)}
                    className="text-xs px-2 py-0.5 rounded bg-status-dnd/40 hover:bg-status-dnd/60 text-text-primary"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing?.displayName ?? ''}
      >
        <pre className="bg-bg-floating text-text-secondary text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-[60vh]">
          {body || '（載入中…）'}
        </pre>
      </Modal>
    </div>
  )
}
