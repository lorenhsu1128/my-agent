import { useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useSessionStore } from '../../store/sessionStore'
import { useMessageStore } from '../../store/messageStore'
import { usePermissionStore } from '../../store/permissionStore'
import { useTurnEvents } from '../../hooks/useTurnEvents'
import { useTurnState } from '../../hooks/useTurnState'
import { useWsClient } from '../../hooks/useWsClient'
import { useSessionBackfill } from '../../hooks/useSessionBackfill'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

export function ChatView() {
  const ws = useWsClient()
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s => (selectedId ? s.projects[selectedId] : null))
  const sessionId = useSessionStore(s => (selectedId ? s.selectedSessionByProject[selectedId] : null))
  const activeSessionId = useSessionStore(s => (selectedId ? s.activeSessionByProject[selectedId] : null))
  const messagesLoading = useSessionStore(s =>
    selectedId && sessionId ? (s.loadingMessagesByProject[selectedId]?.[sessionId] ?? false) : false,
  )
  const messagesError = useSessionStore(s =>
    selectedId && sessionId ? (s.errorMessagesByProject[selectedId]?.[sessionId] ?? null) : null,
  )
  const turnState = useTurnState(selectedId)
  const pendingPermission = usePermissionStore(s =>
    selectedId ? s.pendingByProject[selectedId] ?? null : null,
  )
  const [lastInputId, setLastInputId] = useState<string | null>(null)

  useTurnEvents(ws, sessionId ?? null, selectedId)
  useSessionBackfill(selectedId, sessionId ?? null)

  const isHistoricalSession = !!sessionId && !!activeSessionId && sessionId !== activeSessionId

  if (!project) {
    return (
      <main className="h-full flex items-center justify-center bg-background text-muted-foreground">
        從左欄選擇 project 開始對話
      </main>
    )
  }
  if (!sessionId) {
    return (
      <main className="h-full flex items-center justify-center bg-background text-muted-foreground">
        正在載入 session…
      </main>
    )
  }

  function send(text: string) {
    if (!ws || !selectedId || !sessionId) return
    if (isHistoricalSession) return
    const placeholderId = 'pend-' + Date.now()
    useMessageStore.getState().startUserTurn(sessionId, placeholderId, text, 'web')
    setLastInputId(placeholderId)
    ws.send({ type: 'input.submit', projectId: selectedId, text, intent: 'interactive' })
  }

  function jumpToActive() {
    if (!selectedId || !activeSessionId) return
    useSessionStore.getState().selectSession(selectedId, activeSessionId)
  }

  function interrupt() {
    if (!ws || !selectedId) return
    ws.send({ type: 'input.interrupt', projectId: selectedId, inputId: lastInputId ?? undefined })
  }

  function setMode(mode: string) {
    if (!ws || !selectedId) return
    ws.send({ type: 'permission.modeSet', projectId: selectedId, mode })
  }

  function permissionResponse(decision: 'allow' | 'deny') {
    if (!ws || !selectedId) return
    if (!pendingPermission) return
    ws.send({
      type: 'permission.respond',
      projectId: selectedId,
      toolUseID: pendingPermission.toolUseID,
      decision,
    })
  }

  function clear() {
    if (!sessionId) return
    useMessageStore.getState().clearSession(sessionId)
  }

  const stateLabel =
    turnState === 'RUNNING' ? '⟳ 執行中…' : turnState === 'INTERRUPTING' ? '⏸ 中斷中…' : '· idle'

  return (
    <main className="h-full flex flex-col bg-background min-w-0">
      <header className="h-12 px-4 border-b flex items-center justify-between flex-shrink-0">
        <div className="flex flex-col min-w-0">
          <span className="font-semibold truncate">{project.name}</span>
          <span className="text-muted-foreground text-xs font-mono truncate">{project.cwd}</span>
        </div>
        <span className="text-muted-foreground text-xs">{stateLabel}</span>
      </header>
      {isHistoricalSession && (
        <div className="px-4 py-2 bg-accent border-b text-xs flex items-center justify-between gap-3 flex-shrink-0">
          <span className="text-accent-foreground">📚 歷史 session（read-only 預覽）</span>
          <Button variant="link" size="sm" onClick={jumpToActive} className="h-auto p-0">
            <ArrowLeft className="h-3 w-3 mr-1" /> 切回 active
          </Button>
        </div>
      )}
      {messagesLoading && (
        <div className="px-4 py-1.5 bg-muted text-xs text-muted-foreground flex-shrink-0">
          ⟳ 載入歷史訊息…
        </div>
      )}
      {messagesError && (
        <div className="px-4 py-1.5 bg-destructive/15 text-xs text-destructive flex-shrink-0">
          ⚠ backfill 失敗：{messagesError}
        </div>
      )}
      <MessageList sessionId={sessionId} />
      <InputBar
        onSubmit={send}
        onInterrupt={interrupt}
        onSetMode={setMode}
        onPermissionResponse={permissionResponse}
        onClear={clear}
        disabled={isHistoricalSession}
        hint={
          isHistoricalSession
            ? '歷史 session — 點上方「切回 active」才能送訊息'
            : `session ${sessionId.slice(0, 8)}${pendingPermission ? ' · 等待 permission（/allow 或 /deny）' : ''}`
        }
      />
    </main>
  )
}
