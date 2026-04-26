import { useState } from 'react'
import { useSessionStore } from '../../store/sessionStore'
import { useProjectStore } from '../../store/projectStore'
import { formatTimeAgo } from '../../utils/timeAgo'
import type { WebSessionInfo } from '../../api/types'

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
  const selectedSessionId = useSessionStore(
    s => s.selectedSessionByProject[projectId],
  )
  const activeSessionId = useSessionStore(
    s => s.activeSessionByProject[projectId],
  )
  const selectSession = useSessionStore(s => s.selectSession)
  const selectProject = useProjectStore(s => s.selectProject)
  const [showAll, setShowAll] = useState(false)

  if (sessions.length === 0) {
    return (
      <div className="pl-6 py-1 text-xs text-text-muted">（無 session）</div>
    )
  }

  // active 永遠優先；其餘照原 server-side 順序（startedAt DESC）
  const sorted = [
    ...sessions.filter(s => s.sessionId === activeSessionId),
    ...sessions.filter(s => s.sessionId !== activeSessionId),
  ]
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE)
  const hidden = sorted.length - visible.length

  return (
    <ul className="ml-2 border-l border-divider/50">
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
            className={[
              'px-2 py-1.5 cursor-pointer rounded mx-1 my-0.5 flex flex-col gap-0.5',
              isSelected
                ? 'bg-bg-accent text-text-primary'
                : 'text-text-secondary hover:bg-bg-accent/60 hover:text-text-primary',
            ].join(' ')}
            title={`${s.sessionId}\n${label}`}
          >
            <div className="flex items-center gap-1.5 text-sm">
              {isActive ? (
                <span
                  title="active session"
                  className="text-status-online text-[10px] flex-shrink-0"
                >
                  ●
                </span>
              ) : (
                <span className="text-text-muted text-[10px] flex-shrink-0">
                  ○
                </span>
              )}
              <span className="truncate flex-1">{label}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-text-muted font-mono pl-3.5">
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
          className="px-2 py-1 mx-1 text-xs text-brand cursor-pointer hover:underline"
        >
          + 顯示更多 ({hidden})
        </li>
      )}
      {showAll && sorted.length > DEFAULT_VISIBLE && (
        <li
          onClick={() => setShowAll(false)}
          className="px-2 py-1 mx-1 text-xs text-text-muted cursor-pointer hover:underline"
        >
          收合
        </li>
      )}
    </ul>
  )
}
