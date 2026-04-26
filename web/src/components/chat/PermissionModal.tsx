/**
 * M-WEB-13：Permission prompt modal — 顯示當前 selected project 的 pending
 * permission；按 Allow / Deny 經 WS 回 permission.respond。first-wins：另一端
 * 先回 → daemon 廣播 permission.resolved → 此 modal 自動消失。
 */
import { Modal } from '../common/Modal'
import { useProjectStore } from '../../store/projectStore'
import { usePermissionStore } from '../../store/permissionStore'
import { useWsClient } from '../../hooks/useWsClient'

export function PermissionModal() {
  const ws = useWsClient()
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const pending = usePermissionStore(s =>
    selectedId ? s.pendingByProject[selectedId] ?? null : null,
  )

  if (!selectedId || !pending) return null

  function decide(decision: 'allow' | 'deny') {
    if (!ws || !selectedId || !pending) return
    ws.send({
      type: 'permission.respond',
      projectId: selectedId,
      toolUseID: pending.toolUseID,
      decision,
    })
    // 不直接清 — 等 daemon 廣播 permission.resolved 才清，這樣 first-wins
    // 與 TUI / Discord 端一致
  }

  return (
    <Modal open={true} onClose={() => decide('deny')} title="Tool Permission Request">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-brand font-mono">{pending.toolName}</span>
          {pending.riskLevel && (
            <span
              className={[
                'text-[10px] uppercase rounded px-1.5 py-0.5',
                pending.riskLevel === 'destructive'
                  ? 'bg-status-dnd/30 text-status-dnd'
                  : pending.riskLevel === 'write'
                    ? 'bg-status-idle/30 text-status-idle'
                    : 'bg-status-online/30 text-status-online',
              ].join(' ')}
            >
              {pending.riskLevel}
            </span>
          )}
        </div>
        {pending.description && (
          <div className="text-text-secondary text-sm">
            {pending.description}
          </div>
        )}
        {pending.affectedPaths && pending.affectedPaths.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-text-muted text-xs uppercase">
              Affected paths
            </span>
            {pending.affectedPaths.map(p => (
              <span
                key={p}
                className="font-mono text-xs text-text-secondary break-all"
              >
                {p}
              </span>
            ))}
          </div>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer text-text-muted">tool input</summary>
          <pre className="bg-bg-floating text-text-secondary p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-64">
            {(() => {
              try {
                return JSON.stringify(pending.input, null, 2)
              } catch {
                return String(pending.input)
              }
            })()}
          </pre>
        </details>
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={() => decide('deny')}
            className="px-4 py-2 rounded bg-status-dnd hover:opacity-90 text-white"
          >
            Deny
          </button>
          <button
            onClick={() => decide('allow')}
            className="px-4 py-2 rounded bg-status-online hover:opacity-90 text-white"
          >
            Allow
          </button>
        </div>
      </div>
    </Modal>
  )
}
