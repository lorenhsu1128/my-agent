/**
 * M-WEB-11/12：取代 ChatPlaceholder，組合 MessageList + InputBar + WS turn events。
 * M-WEB-22：歷史 session backfill + 非 active session 鎖 input。
 */
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

export function ChatView() {
  const ws = useWsClient()
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s =>
    selectedId ? s.projects[selectedId] : null,
  )
  const sessionId = useSessionStore(s =>
    selectedId ? s.selectedSessionByProject[selectedId] : null,
  )
  const activeSessionId = useSessionStore(s =>
    selectedId ? s.activeSessionByProject[selectedId] : null,
  )
  const messagesLoading = useSessionStore(s =>
    selectedId && sessionId
      ? (s.loadingMessagesByProject[selectedId]?.[sessionId] ?? false)
      : false,
  )
  const messagesError = useSessionStore(s =>
    selectedId && sessionId
      ? (s.errorMessagesByProject[selectedId]?.[sessionId] ?? null)
      : null,
  )
  const turnState = useTurnState(selectedId)
  const pendingPermission = usePermissionStore(s =>
    selectedId ? s.pendingByProject[selectedId] ?? null : null,
  )
  const [lastInputId, setLastInputId] = useState<string | null>(null)

  useTurnEvents(ws, sessionId ?? null, selectedId)
  useSessionBackfill(selectedId, sessionId ?? null)

  const isHistoricalSession =
    !!sessionId && !!activeSessionId && sessionId !== activeSessionId

  if (!project) {
    return (
      <main className="flex-1 flex items-center justify-center bg-bg-primary text-text-muted">
        從左欄選擇 project 開始對話
      </main>
    )
  }
  if (!sessionId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-bg-primary text-text-muted">
        正在載入 session…
      </main>
    )
  }

  function send(text: string) {
    if (!ws || !selectedId || !sessionId) return
    // 歷史 session 不送（daemon 沒 attach API；走 active 才有意義）
    if (isHistoricalSession) return
    // 樂觀 append user message — daemon side 會在 turn.start 用相同 inputId 對齊
    // 但 input.submit 沒有 inputId 回傳；這裡先用 placeholder + 後續 turn.start 創 assistant pair
    const placeholderId = 'pend-' + Date.now()
    useMessageStore
      .getState()
      .startUserTurn(sessionId, placeholderId, text, 'web')
    setLastInputId(placeholderId)
    ws.send({
      type: 'input.submit',
      projectId: selectedId,
      text,
      intent: 'interactive',
    })
  }

  function jumpToActive() {
    if (!selectedId || !activeSessionId) return
    useSessionStore
      .getState()
      .selectSession(selectedId, activeSessionId)
  }

  function interrupt() {
    if (!ws || !selectedId) return
    ws.send({
      type: 'input.interrupt',
      projectId: selectedId,
      inputId: lastInputId ?? undefined,
    })
  }

  function setMode(mode: string) {
    if (!ws || !selectedId) return
    ws.send({
      type: 'permission.modeSet',
      projectId: selectedId,
      mode,
    })
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
    turnState === 'RUNNING'
      ? '⟳ 執行中…'
      : turnState === 'INTERRUPTING'
        ? '⏸ 中斷中…'
        : '· idle'

  return (
    <main className="flex-1 flex flex-col bg-bg-primary min-w-0">
      <header className="h-12 px-4 border-b border-divider flex items-center justify-between flex-shrink-0">
        <div className="flex flex-col min-w-0">
          <span className="text-text-primary font-semibold truncate">
            {project.name}
          </span>
          <span className="text-text-muted text-xs font-mono truncate">
            {project.cwd}
          </span>
        </div>
        <span className="text-text-muted text-xs">{stateLabel}</span>
      </header>
      {isHistoricalSession && (
        <div
          className="px-4 py-2 bg-status-idle/15 border-b border-status-idle/30 text-xs flex items-center justify-between gap-3 flex-shrink-0"
          title="歷史 session 為唯讀預覽 — 要繼續對話請切回 active session"
        >
          <span className="text-status-idle">
            📚 歷史 session（read-only 預覽）
          </span>
          <button
            onClick={jumpToActive}
            className="text-brand hover:underline whitespace-nowrap"
          >
            ← 切回 active
          </button>
        </div>
      )}
      {messagesLoading && (
        <div className="px-4 py-1.5 bg-bg-accent/40 text-xs text-text-muted flex-shrink-0">
          ⟳ 載入歷史訊息…
        </div>
      )}
      {messagesError && (
        <div className="px-4 py-1.5 bg-status-dnd/20 text-xs text-status-dnd flex-shrink-0">
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
