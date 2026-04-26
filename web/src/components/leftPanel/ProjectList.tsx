import { useState } from 'react'
import { listProjectsSorted, useProjectStore } from '../../store/projectStore'
import { api } from '../../api/client'
import { SessionTree } from './SessionTree'
import { AddProjectDialog } from './AddProjectDialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ProjectList() {
  const projects = useProjectStore(s => s.projects)
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const loadError = useProjectStore(s => s.loadError)
  const loading = useProjectStore(s => s.loading)
  const selectProject = useProjectStore(s => s.selectProject)
  const removeProject = useProjectStore(s => s.removeProject)

  const sorted = listProjectsSorted(projects)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingUnload, setPendingUnload] = useState<string | null>(null)

  function toggleExpanded(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  async function unload(id: string) {
    try {
      await api.unloadProject(id)
      removeProject(id)
    } catch (err) {
      alert(`unload 失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPendingUnload(null)
    }
  }

  return (
    <>
      <aside className="h-full bg-sidebar text-sidebar-foreground border-r flex flex-col">
        <header className="px-4 py-3 border-b flex items-center justify-between">
          <span className="text-sm font-semibold">Projects</span>
          <Button variant="ghost" size="icon" onClick={() => setDialogOpen(true)} title="加入 project">
            <Plus className="h-4 w-4" />
          </Button>
        </header>
        <ScrollArea className="flex-1 py-2">
          {loadError && <div className="px-4 py-2 text-destructive text-xs">⚠ {loadError}</div>}
          {loading && <div className="px-4 py-2 text-muted-foreground text-xs">載入中…</div>}
          {!loading && sorted.length === 0 && !loadError && (
            <div className="px-4 py-2 text-muted-foreground text-xs">尚無 project — 點 + 加入</div>
          )}
          {sorted.map(p => {
            const isOpen = expanded[p.projectId] ?? p.projectId === selectedId
            const isSelected = selectedId === p.projectId
            return (
              <div key={p.projectId}>
                <div
                  onClick={() => {
                    selectProject(p.projectId)
                    if (!isOpen) toggleExpanded(p.projectId)
                  }}
                  className={cn(
                    'flex items-center gap-1 px-2 mx-2 py-1.5 cursor-pointer rounded-md text-sm group',
                    isSelected
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-sidebar-accent/60',
                  )}
                >
                  <button
                    onClick={e => { e.stopPropagation(); toggleExpanded(p.projectId) }}
                    className="text-muted-foreground"
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <span className="flex-1 truncate" title={p.cwd}>{p.name}</span>
                  {p.hasAttachedRepl && (
                    <span title={`${p.attachedReplCount} attached`} className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--chart-3))]" />
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={e => e.stopPropagation()}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setPendingUnload(p.projectId)}
                      >
                        移除（unload）
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {isOpen && <SessionTree projectId={p.projectId} />}
              </div>
            )
          })}
        </ScrollArea>
      </aside>
      <AddProjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <AlertDialog open={!!pendingUnload} onOpenChange={o => { if (!o) setPendingUnload(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定 unload 此 project？</AlertDialogTitle>
            <AlertDialogDescription>
              不會刪除 session 歷史，只是把 project 從目前的 daemon registry 移除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingUnload && void unload(pendingUnload)}>
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
