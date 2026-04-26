import { useState } from 'react'
import { useSessionStore } from '../../store/sessionStore'
import { useProjectStore } from '../../store/projectStore'
import { formatTimeAgo } from '../../utils/timeAgo'
import type { WebSessionInfo } from '../../api/types'
import { cn } from '@/lib/utils'

export interface SessionTreeProps {
  projectId: string
}

const DEFAULT_VISIBLE = 10

function shortLabel(s: WebSessionInfo): string {
  if (s.firstUserMessage && s.firstUserMessage.trim().length > 0) {
    const oneLine = s.firstUserMessage.replace(/\s+/g, ' ').trim()
    return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine
  }
  return '(empty session)'
}

export function SessionTree({ projectId }: SessionTreeProps) {
  const sessions = useSessionStore(s => s.byProject[projectId] ?? [])
  const selectedSessionId = useSessionStore(s => s.selectedSessionByProject[projectId])
  const activeSessionId = useSessionStore(s => s.activeSessionByProject[projectId])
  const selectSession = useSessionStore(s => s.selectSession)
  const selectProject = useProjectStore(s => s.selectProject)
  const [showAll, setShowAll] = useState(false)

  if (sessions.length === 0) {
    return <div className="pl-6 py-1 text-xs text-muted-foreground">（無 session）</div>
  }

  const sorted = [
    ...sessions.filter(s => s.sessionId === activeSessionId),
    ...sessions.filter(s => s.sessionId !== activeSessionId),
  ]
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE)
  const hidden = sorted.length - visible.length

  return (
    <ul className="ml-3 border-l border-border/50">
      {visible.map(s => {
        const isSelected = s.sessionId === selectedSessionId
        const isActive = s.sessionId === activeSessionId
        const label = shortLabel(s)
        return (
          <li
            key={s.sessionId}
            onClick={() => {
              selectProject(projectId)
              selectSession(projectId, s.sessionId)
            }}
            className={cn(
              'px-2 py-1.5 cursor-pointer rounded-md mx-1 my-0.5 flex flex-col gap-0.5',
              isSelected
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'hover:bg-sidebar-accent/60',
            )}
            title={`${s.sessionId}\n${label}`}
          >
            <div className="flex items-center gap-1.5 text-sm">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full flex-shrink-0',
                  isActive ? 'bg-[hsl(var(--chart-3))]' : 'bg-muted-foreground/40',
                )}
                title={isActive ? 'active' : 'inactive'}
              />
              <span className="truncate flex-1">{label}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono pl-3">
              <span>{s.sessionId.slice(0, 8)}</span>
              <span>·</span>
              <span>{formatTimeAgo(s.startedAt)}</span>
              {typeof s.messageCount === 'number' && s.messageCount > 0 && (
                <>
                  <span>·</span>
                  <span>{s.messageCount} msg</span>
                </>
              )}
            </div>
          </li>
        )
      })}
      {hidden > 0 && (
        <li
          onClick={() => setShowAll(true)}
          className="px-2 py-1 mx-1 text-xs text-primary cursor-pointer hover:underline"
        >
          + 顯示更多 ({hidden})
        </li>
      )}
      {showAll && sorted.length > DEFAULT_VISIBLE && (
        <li
          onClick={() => setShowAll(false)}
          className="px-2 py-1 mx-1 text-xs text-muted-foreground cursor-pointer hover:underline"
        >
          收合
        </li>
      )}
    </ul>
  )
}
