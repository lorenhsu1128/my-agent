import { useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import { usePermissionStore } from '../../../store/permissionStore'
import { useWsClient } from '../../../hooks/useWsClient'

export interface PermissionsTabProps {
  projectId: string
}

const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan']

export function PermissionsTab({ projectId }: PermissionsTabProps) {
  const ws = useWsClient()
  const project = useProjectStore(s => s.projects[projectId])
  const mode = usePermissionStore(
    s => s.modeByProject[projectId] ?? 'default',
  )
  const pending = usePermissionStore(s => s.pendingByProject[projectId] ?? null)
  const [draft, setDraft] = useState<string>(mode)

  function applyMode(next: string) {
    if (!ws) return
    setDraft(next)
    ws.send({ type: 'permission.modeSet', projectId, mode: next })
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-text-muted text-xs uppercase tracking-wide">
        Permissions
      </span>
      <div className="flex flex-col gap-2">
        <span className="text-text-muted text-xs">Mode</span>
        <div className="flex flex-col gap-1">
          {MODES.map(m => (
            <label
              key={m}
              className="flex items-center gap-2 cursor-pointer text-sm"
            >
              <input
                type="radio"
                name="permission-mode"
                checked={draft === m}
                onChange={() => applyMode(m)}
                className="accent-brand"
              />
              <span>{m}</span>
              {m === mode && (
                <span className="text-status-online text-[10px]">active</span>
              )}
            </label>
          ))}
        </div>
        <span className="text-text-muted text-xs">
          切換會經 WS 廣播到 TUI / Discord 全端同步
        </span>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <span className="text-text-muted text-xs">當前 pending request</span>
        {pending ? (
          <div className="bg-bg-tertiary border border-divider/50 rounded p-2 text-xs">
            <div className="text-brand font-mono mb-1">{pending.toolName}</div>
            {pending.description && (
              <div className="text-text-secondary mb-1">
                {pending.description}
              </div>
            )}
            <div className="text-text-muted">
              from{' '}
              {pending.sourceClientId
                ? pending.sourceClientId.slice(0, 8)
                : '(unknown)'}{' '}
              · {new Date(pending.receivedAt).toLocaleTimeString()}
            </div>
          </div>
        ) : (
          <div className="text-text-muted text-xs">（無 pending）</div>
        )}
      </div>

      {project && (
        <div className="text-text-muted text-xs">
          attached REPL: {project.attachedReplCount}
        </div>
      )}
    </div>
  )
}
