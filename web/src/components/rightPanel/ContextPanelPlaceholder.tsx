import { useProjectStore } from '../../store/projectStore'

export function ContextPanelPlaceholder() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s =>
    selectedId ? s.projects[selectedId] : null,
  )
  return (
    <aside className="w-72 bg-bg-secondary border-l border-divider flex flex-col">
      <header className="px-4 py-3 border-b border-divider">
        <span className="text-sm font-semibold text-text-primary">Context</span>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {project ? (
          <div className="flex flex-col gap-3">
            <Section title="Project">
              <KV k="id" v={<span className="font-mono text-xs">{project.projectId.slice(0, 12)}</span>} />
              <KV k="name" v={project.name} />
              <KV
                k="cwd"
                v={<span className="font-mono text-xs break-all">{project.cwd}</span>}
              />
              <KV
                k="attached REPL"
                v={`${project.attachedReplCount}`}
              />
            </Section>
            <Section title="Cron / Memory / Llamacpp">
              <div className="text-text-muted text-xs">
                完整 CRUD 待 M-WEB-14/15/16 接上
              </div>
            </Section>
          </div>
        ) : (
          <div className="text-text-muted text-sm">
            從左欄選擇 project 後顯示細節
          </div>
        )}
      </div>
    </aside>
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
