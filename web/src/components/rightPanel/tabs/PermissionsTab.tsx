import { useState, useEffect } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import { usePermissionStore } from '../../../store/permissionStore'
import { useWsClient } from '../../../hooks/useWsClient'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

export interface PermissionsTabProps {
  projectId: string
}

const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan']

export function PermissionsTab({ projectId }: PermissionsTabProps) {
  const ws = useWsClient()
  const project = useProjectStore(s => s.projects[projectId])
  const mode = usePermissionStore(s => s.modeByProject[projectId] ?? 'default')
  const pending = usePermissionStore(s => s.pendingByProject[projectId] ?? null)
  const [draft, setDraft] = useState<string>(mode)

  useEffect(() => { setDraft(mode) }, [mode])

  function applyMode(next: string) {
    if (!ws) return
    setDraft(next)
    ws.send({ type: 'permission.modeSet', projectId, mode: next })
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">Permissions</span>

      <div className="flex flex-col gap-2">
        <Label>Mode</Label>
        <div className="flex flex-col gap-1">
          {MODES.map(m => (
            <label key={m} className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="permission-mode"
                checked={draft === m}
                onChange={() => applyMode(m)}
                className="accent-primary"
              />
              <span>{m}</span>
              {m === mode && <Badge variant="secondary" className="text-[10px] uppercase">active</Badge>}
            </label>
          ))}
        </div>
        <span className="text-muted-foreground text-xs">切換會經 WS 廣播到 TUI / Discord 全端同步</span>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <Label>當前 pending request</Label>
        {pending ? (
          <Card>
            <CardContent className="p-2 text-xs">
              <div className="text-primary font-mono mb-1">{pending.toolName}</div>
              {pending.description && <div className="mb-1">{pending.description}</div>}
              <div className="text-muted-foreground">
                from {pending.sourceClientId ? pending.sourceClientId.slice(0, 8) : '(unknown)'} ·{' '}
                {new Date(pending.receivedAt).toLocaleTimeString()}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="text-muted-foreground text-xs">（無 pending）</div>
        )}
      </div>

      {project && (
        <div className="text-muted-foreground text-xs">attached REPL: {project.attachedReplCount}</div>
      )}
    </div>
  )
}
