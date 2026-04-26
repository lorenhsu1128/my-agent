import { useProjectStore } from '../../store/projectStore'
import { useSessionStore } from '../../store/sessionStore'

export function ChatPlaceholder() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s =>
    selectedId ? s.projects[selectedId] : null,
  )
  const sessionId = useSessionStore(s =>
    selectedId ? s.selectedSessionByProject[selectedId] : null,
  )
  return (
    <main className="flex-1 flex flex-col bg-bg-primary">
      <header className="h-12 px-4 border-b border-divider flex items-center">
        {project ? (
          <div className="flex flex-col">
            <span className="text-text-primary font-semibold">
              {project.name}
            </span>
            <span className="text-text-muted text-xs font-mono truncate">
              {project.cwd}
            </span>
          </div>
        ) : (
          <span className="text-text-muted">無 project 選取</span>
        )}
      </header>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-text-muted text-sm">
            {project
              ? `session ${sessionId?.slice(0, 8) ?? '—'} · 聊天介面待 M-WEB-10/11/12 接上`
              : '從左欄選擇 project 開始對話'}
          </div>
        </div>
      </div>
    </main>
  )
}
