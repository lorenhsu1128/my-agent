/**
 * M-WEB-9/14：右欄 Tabbed Context Panel（取代 ContextPanelPlaceholder）。
 * Tabs：Overview / Cron / Memory / Llamacpp / Discord / Permissions
 */
import { useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { CronTab } from './tabs/CronTab'
import { MemoryTab } from './tabs/MemoryTab'
import { LlamacppTab } from './tabs/LlamacppTab'
import { DiscordTab } from './tabs/DiscordTab'
import { PermissionsTab } from './tabs/PermissionsTab'

type TabId =
  | 'overview'
  | 'cron'
  | 'memory'
  | 'llamacpp'
  | 'discord'
  | 'permissions'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'cron', label: 'Cron' },
  { id: 'memory', label: 'Memory' },
  { id: 'llamacpp', label: 'Llamacpp' },
  { id: 'discord', label: 'Discord' },
  { id: 'permissions', label: 'Perms' },
]

export function ContextPanel() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s =>
    selectedId ? s.projects[selectedId] : null,
  )
  const [tab, setTab] = useState<TabId>('overview')
  return (
    <aside className="w-80 bg-bg-secondary border-l border-divider flex flex-col flex-shrink-0">
      <div className="border-b border-divider flex overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              'px-3 py-2 text-xs whitespace-nowrap transition-colors',
              tab === t.id
                ? 'text-text-primary border-b-2 border-brand -mb-px'
                : 'text-text-muted hover:text-text-secondary',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!selectedId || !project ? (
          <div className="text-text-muted text-sm">
            從左欄選擇 project 後顯示細節
          </div>
        ) : tab === 'overview' ? (
          <OverviewTab projectId={selectedId} />
        ) : tab === 'cron' ? (
          <CronTab projectId={selectedId} />
        ) : tab === 'memory' ? (
          <MemoryTab projectId={selectedId} />
        ) : tab === 'llamacpp' ? (
          <LlamacppTab />
        ) : tab === 'discord' ? (
          <DiscordTab />
        ) : tab === 'permissions' ? (
          <PermissionsTab projectId={selectedId} />
        ) : null}
      </div>
    </aside>
  )
}

function OverviewTab({ projectId }: { projectId: string }) {
  const project = useProjectStore(s => s.projects[projectId])
  if (!project) return null
  return (
    <div className="flex flex-col gap-3">
      <Section title="Project">
        <KV
          k="id"
          v={
            <span className="font-mono text-xs">
              {project.projectId.slice(0, 12)}
            </span>
          }
        />
        <KV k="name" v={project.name} />
        <KV
          k="cwd"
          v={
            <span className="font-mono text-xs break-all">{project.cwd}</span>
          }
        />
        <KV k="attached REPL" v={`${project.attachedReplCount}`} />
        <KV
          k="last activity"
          v={new Date(project.lastActivityAt).toLocaleString()}
        />
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase text-text-muted tracking-wide">
        {title}
      </h3>
      {children}
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-text-muted">{k}</span>
      <span className="text-sm text-text-primary">{v}</span>
    </div>
  )
}
