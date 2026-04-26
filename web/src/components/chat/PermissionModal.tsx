import { useProjectStore } from '../../store/projectStore'
import { usePermissionStore } from '../../store/permissionStore'
import { useWsClient } from '../../hooks/useWsClient'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'

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
  }

  const riskVariant: 'destructive' | 'secondary' | 'outline' =
    pending.riskLevel === 'destructive'
      ? 'destructive'
      : pending.riskLevel === 'write'
        ? 'outline'
        : 'secondary'

  return (
    <AlertDialog open onOpenChange={open => { if (!open) decide('deny') }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <span className="font-mono text-primary">{pending.toolName}</span>
            {pending.riskLevel && (
              <Badge variant={riskVariant} className="text-[10px] uppercase">
                {pending.riskLevel}
              </Badge>
            )}
          </AlertDialogTitle>
          {pending.description && (
            <AlertDialogDescription>{pending.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {pending.affectedPaths && pending.affectedPaths.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs uppercase">Affected paths</span>
            {pending.affectedPaths.map(p => (
              <span key={p} className="font-mono text-xs break-all">
                {p}
              </span>
            ))}
          </div>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">tool input</summary>
          <pre className="bg-muted text-foreground p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-64 font-mono">
            {(() => {
              try {
                return JSON.stringify(pending.input, null, 2)
              } catch {
                return String(pending.input)
              }
            })()}
          </pre>
        </details>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => decide('deny')}>Deny</AlertDialogCancel>
          <AlertDialogAction onClick={() => decide('allow')}>Allow</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
