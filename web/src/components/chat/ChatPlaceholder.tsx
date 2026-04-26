import { MessagesSquare } from 'lucide-react'
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
    <main className="flex-1 flex flex-col bg-background h-full">
      <header className="h-12 px-4 border-b flex items-center">
        {project ? (
          <div className="flex flex-col">
            <span className="font-semibold">{project.name}</span>
            <span className="text-muted-foreground text-xs font-mono truncate">
              {project.cwd}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">無 project 選取</span>
        )}
      </header>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center text-muted-foreground text-sm flex flex-col items-center gap-3">
          <MessagesSquare className="h-10 w-10 opacity-50" />
          {project
            ? `session ${sessionId?.slice(0, 8) ?? '—'}`
            : '從左欄選擇 project 開始對話'}
        </div>
      </div>
    </main>
  )
}
