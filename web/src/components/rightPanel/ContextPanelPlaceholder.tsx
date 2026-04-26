import { Inbox } from 'lucide-react'
import { useProjectStore } from '../../store/projectStore'
import { ScrollArea } from '@/components/ui/scroll-area'

export function ContextPanelPlaceholder() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s => (selectedId ? s.projects[selectedId] : null))
  return (
    <aside className="h-full bg-sidebar border-l flex flex-col">
      <header className="px-4 py-3 border-b">
        <span className="text-sm font-semibold">Context</span>
      </header>
      <ScrollArea className="flex-1 p-4">
        {project ? (
          <div className="flex flex-col gap-3 text-sm">
            <KV k="id" v={<span className="font-mono text-xs">{project.projectId.slice(0, 12)}</span>} />
            <KV k="name" v={project.name} />
            <KV k="cwd" v={<span className="font-mono text-xs break-all">{project.cwd}</span>} />
            <KV k="attached REPL" v={`${project.attachedReplCount}`} />
          </div>
        ) : (
          <div className="text-muted-foreground text-sm flex flex-col items-center gap-3 py-8">
            <Inbox className="h-8 w-8 opacity-50" />
            從左欄選擇 project 後顯示細節
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className="text-sm">{v}</span>
    </div>
  )
}
