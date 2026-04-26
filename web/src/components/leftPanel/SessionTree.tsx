import { useSessionStore } from '../../store/sessionStore'
import { useProjectStore } from '../../store/projectStore'

export interface SessionTreeProps {
  projectId: string
}

export function SessionTree({ projectId }: SessionTreeProps) {
  const sessions = useSessionStore(s => s.byProject[projectId] ?? [])
  const selectedSessionId = useSessionStore(
    s => s.selectedSessionByProject[projectId],
  )
  const activeSessionId = useSessionStore(
    s => s.activeSessionByProject[projectId],
  )
  const selectSession = useSessionStore(s => s.selectSession)
  const selectProject = useProjectStore(s => s.selectProject)

  if (sessions.length === 0) {
    return (
      <div className="pl-6 py-1 text-xs text-text-muted">（無 session）</div>
    )
  }

  return (
    <ul className="ml-4 border-l border-divider/50">
      {sessions.map(s => {
        const isSelected = s.sessionId === selectedSessionId
        const isActive = s.sessionId === activeSessionId
        return (
          <li
            key={s.sessionId}
            onClick={() => {
              selectProject(projectId)
              selectSession(projectId, s.sessionId)
            }}
            className={[
              'px-2 py-1 cursor-pointer text-sm rounded mx-1 my-0.5',
              isSelected
                ? 'bg-bg-accent text-text-primary'
                : 'text-text-secondary hover:bg-bg-accent/60 hover:text-text-primary',
            ].join(' ')}
            title={s.sessionId}
          >
            <span className="font-mono text-xs">
              {s.sessionId.slice(0, 8)}
            </span>
            {isActive && (
              <span className="ml-2 text-status-online text-[10px]">●</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
