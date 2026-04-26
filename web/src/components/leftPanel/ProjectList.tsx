import { useState } from 'react'
import {
  listProjectsSorted,
  useProjectStore,
} from '../../store/projectStore'
import { api } from '../../api/client'
import { SessionTree } from './SessionTree'
import { AddProjectDialog } from './AddProjectDialog'

export function ProjectList() {
  const projects = useProjectStore(s => s.projects)
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const loadError = useProjectStore(s => s.loadError)
  const loading = useProjectStore(s => s.loading)
  const selectProject = useProjectStore(s => s.selectProject)
  const removeProject = useProjectStore(s => s.removeProject)

  const sorted = listProjectsSorted(projects)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [dialogOpen, setDialogOpen] = useState(false)

  function toggleExpanded(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  async function unload(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('確定 unload 此 project?')) return
    try {
      await api.unloadProject(id)
      removeProject(id)
    } catch (err) {
      alert(`unload 失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <>
      <aside className="w-60 bg-bg-secondary border-r border-divider flex flex-col">
        <header className="px-4 py-3 border-b border-divider flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">
            Projects
          </span>
          <button
            title="加入 project"
            onClick={() => setDialogOpen(true)}
            className="text-text-secondary hover:text-text-primary text-lg leading-none"
          >
            +
          </button>
        </header>
        <div className="flex-1 overflow-y-auto py-2">
          {loadError && (
            <div className="px-4 py-2 text-status-dnd text-xs">
              ⚠ {loadError}
            </div>
          )}
          {loading && (
            <div className="px-4 py-2 text-text-muted text-xs">載入中…</div>
          )}
          {!loading && sorted.length === 0 && !loadError && (
            <div className="px-4 py-2 text-text-muted text-xs">
              尚無 project — 點 + 加入
            </div>
          )}
          {sorted.map(p => {
            const isOpen = expanded[p.projectId] ?? p.projectId === selectedId
            return (
              <div key={p.projectId}>
                <div
                  onClick={() => {
                    selectProject(p.projectId)
                    if (!isOpen) toggleExpanded(p.projectId)
                  }}
                  className={[
                    'flex items-center gap-2 px-2 mx-2 py-1 cursor-pointer rounded text-sm group',
                    selectedId === p.projectId
                      ? 'bg-bg-accent text-text-primary'
                      : 'text-text-secondary hover:bg-bg-accent/60 hover:text-text-primary',
                  ].join(' ')}
                >
                  <span
                    onClick={e => {
                      e.stopPropagation()
                      toggleExpanded(p.projectId)
                    }}
                    className="text-xs w-3 inline-block text-text-muted"
                  >
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="flex-1 truncate" title={p.cwd}>
                    {p.name}
                  </span>
                  {p.hasAttachedRepl && (
                    <span
                      title={`${p.attachedReplCount} attached`}
                      className="text-status-online text-[10px]"
                    >
                      ●
                    </span>
                  )}
                  <button
                    onClick={e => unload(p.projectId, e)}
                    title="移除"
                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-status-dnd text-xs px-1"
                  >
                    ×
                  </button>
                </div>
                {isOpen && <SessionTree projectId={p.projectId} />}
              </div>
            )
          })}
        </div>
      </aside>
      <AddProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}
