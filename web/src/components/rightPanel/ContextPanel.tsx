import { useProjectStore } from '../../store/projectStore'
import { useUiStore, type ContextTabId } from '../../store/uiStore'
import { CronTab } from './tabs/CronTab'
import { MemoryTab } from './tabs/MemoryTab'
import { LlamacppTab } from './tabs/LlamacppTab'
import { DiscordTab } from './tabs/DiscordTab'
import { PermissionsTab } from './tabs/PermissionsTab'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

export function ContextPanel() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s => (selectedId ? s.projects[selectedId] : null))
  const rightTab = useUiStore(s => s.rightTab)
  const setRightTab = useUiStore(s => s.setRightTab)
  return (
    <aside className="h-full bg-sidebar text-sidebar-foreground border-l flex flex-col flex-shrink-0">
      <Tabs
        value={rightTab}
        onValueChange={v => setRightTab(v as ContextTabId)}
        className="flex flex-col h-full"
      >
        <TabsList className="rounded-none w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="cron">Cron</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="llamacpp">Llamacpp</TabsTrigger>
          <TabsTrigger value="discord">Discord</TabsTrigger>
          <TabsTrigger value="permissions">Perms</TabsTrigger>
        </TabsList>
        <ScrollArea className="flex-1">
          <div className="p-3">
            {!selectedId || !project ? (
              <div className="text-muted-foreground text-sm">從左欄選擇 project 後顯示細節</div>
            ) : (
              <>
                <TabsContent value="overview"><OverviewTab projectId={selectedId} /></TabsContent>
                <TabsContent value="cron"><CronTab projectId={selectedId} /></TabsContent>
                <TabsContent value="memory"><MemoryTab projectId={selectedId} /></TabsContent>
                <TabsContent value="llamacpp"><LlamacppTab /></TabsContent>
                <TabsContent value="discord"><DiscordTab /></TabsContent>
                <TabsContent value="permissions"><PermissionsTab projectId={selectedId} /></TabsContent>
              </>
            )}
          </div>
        </ScrollArea>
      </Tabs>
    </aside>
  )
}

function OverviewTab({ projectId }: { projectId: string }) {
  const project = useProjectStore(s => s.projects[projectId])
  if (!project) return null
  return (
    <div className="flex flex-col gap-3">
      <Section title="Project">
        <KV k="id" v={<span className="font-mono text-xs">{project.projectId.slice(0, 12)}</span>} />
        <KV k="name" v={project.name} />
        <KV k="cwd" v={<span className="font-mono text-xs break-all">{project.cwd}</span>} />
        <KV k="attached REPL" v={`${project.attachedReplCount}`} />
        <KV k="last activity" v={new Date(project.lastActivityAt).toLocaleString()} />
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">{title}</h3>
      {children}
    </div>
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
