import { useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore, type ContextSection } from '../../store/uiStore'
import { useCronStore } from '../../store/cronStore'
import { usePermissionStore } from '../../store/permissionStore'
import { useSessionStore } from '../../store/sessionStore'
import { useMessageStore } from '../../store/messageStore'
import { useWsClient } from '../../hooks/useWsClient'
import { useTurnState } from '../../hooks/useTurnState'
import { api } from '../../api/client'
import type { ServerEvent } from '../../api/types'
import { CronTab } from './tabs/CronTab'
import { MemoryTab } from './tabs/MemoryTab'
import { MemoryRecallTab } from './tabs/MemoryRecallTab'
import { LlamacppTab } from './tabs/LlamacppTab'
import { DiscordTab } from './tabs/DiscordTab'
import { PermissionsTab } from './tabs/PermissionsTab'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import {
  Info,
  Clock,
  Database,
  Cpu,
  MessageCircle,
  Shield,
  Brain,
  type LucideIcon,
} from 'lucide-react'

type SectionDef = {
  id: Exclude<ContextSection, ''>
  label: string
  icon: LucideIcon
}

const SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'cron', label: 'Cron', icon: Clock },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'memory-recall', label: 'Memory Recall', icon: Brain },
  { id: 'llamacpp', label: 'Llamacpp', icon: Cpu },
  { id: 'discord', label: 'Discord', icon: MessageCircle },
  { id: 'permissions', label: 'Permissions', icon: Shield },
]

export function ContextPanel() {
  const selectedId = useProjectStore(s => s.selectedProjectId)
  const project = useProjectStore(s => (selectedId ? s.projects[selectedId] : null))
  const rightTab = useUiStore(s => s.rightTab)
  const setRightTab = useUiStore(s => s.setRightTab)

  const cronCount = useCronStore(s =>
    selectedId ? (s.byProject[selectedId]?.length ?? 0) : 0,
  )
  const hasPendingPermission = usePermissionStore(s =>
    selectedId ? !!s.pendingByProject[selectedId] : false,
  )
  const memoryCount = useMemoryCount(selectedId)

  return (
    <aside className="h-full bg-sidebar text-sidebar-foreground border-l flex flex-col flex-shrink-0">
      {!selectedId || !project ? (
        <div className="p-3 text-muted-foreground text-sm">
          從左欄選擇 project 後顯示細節
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <Accordion
            type="single"
            collapsible
            value={rightTab}
            onValueChange={v => setRightTab(v as ContextSection)}
            className="w-full"
          >
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <AccordionItem key={id} value={id} className="px-3">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{label}</span>
                    <SectionBadge
                      id={id}
                      cronCount={cronCount}
                      memoryCount={memoryCount}
                      hasPendingPermission={hasPendingPermission}
                    />
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <SectionBody id={id} projectId={selectedId} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </ScrollArea>
      )}
    </aside>
  )
}

function SectionBadge({
  id,
  cronCount,
  memoryCount,
  hasPendingPermission,
}: {
  id: SectionDef['id']
  cronCount: number
  memoryCount: number | null
  hasPendingPermission: boolean
}) {
  if (id === 'cron' && cronCount > 0) {
    return (
      <Badge variant="secondary" className="ml-auto mr-2">
        {cronCount}
      </Badge>
    )
  }
  if (id === 'memory' && memoryCount !== null && memoryCount > 0) {
    return (
      <Badge variant="secondary" className="ml-auto mr-2">
        {memoryCount}
      </Badge>
    )
  }
  if (id === 'permissions' && hasPendingPermission) {
    return (
      <Badge variant="destructive" className="ml-auto mr-2">
        !
      </Badge>
    )
  }
  return null
}

function SectionBody({
  id,
  projectId,
}: {
  id: SectionDef['id']
  projectId: string
}) {
  switch (id) {
    case 'overview':
      return <OverviewBody projectId={projectId} />
    case 'cron':
      return <CronTab projectId={projectId} />
    case 'memory':
      return <MemoryTab projectId={projectId} />
    case 'memory-recall':
      return <MemoryRecallTab projectId={projectId} />
    case 'llamacpp':
      return <LlamacppTab />
    case 'discord':
      return <DiscordTab />
    case 'permissions':
      return <PermissionsTab projectId={projectId} />
  }
}

function OverviewBody({ projectId }: { projectId: string }) {
  const project = useProjectStore(s => s.projects[projectId])
  if (!project) return null
  return (
    <div className="flex flex-col gap-3">
      <StatusCard projectId={projectId} />
      <Section title="Project">
        <KV
          k="id"
          v={<span className="font-mono text-xs">{project.projectId.slice(0, 12)}</span>}
        />
        <KV k="name" v={project.name} />
        <KV
          k="cwd"
          v={<span className="font-mono text-xs break-all">{project.cwd}</span>}
        />
        <KV k="attached REPL" v={`${project.attachedReplCount}`} />
        <KV k="last activity" v={new Date(project.lastActivityAt).toLocaleString()} />
      </Section>
    </div>
  )
}

/**
 * M-WEB-PARITY-8：Overview tab 上方的即時狀態卡片。
 * - Model：當前生效的 model（GET /api/models 拉，refresh on model.changed frame）
 * - Permission mode：來自 permissionStore
 * - State：來自 useTurnState（IDLE / RUNNING / INTERRUPTING）
 * - Messages：當前 session 的訊息數（含 assistant turn 中的 in-flight）
 * - Approx tokens：簡單 char/4 估算（精確 cost 要 daemon 暴露 usage 才行；
 *   目前先給粗略概念，避免假資訊）
 */
function StatusCard({ projectId }: { projectId: string }) {
  const ws = useWsClient()
  const [model, setModel] = useState<string | null>(null)
  const mode = usePermissionStore(s => s.modeByProject[projectId] ?? 'default')
  const sessionId = useSessionStore(
    s => s.selectedSessionByProject[projectId],
  )
  const messages = useMessageStore(s =>
    sessionId ? (s.bySession[sessionId] ?? []) : [],
  )
  const turnState = useTurnState(projectId)

  // 拉當前 model + 訂閱 model.changed
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      api
        .listModels()
        .then(r => {
          if (!cancelled) setModel(r.current)
        })
        .catch(() => {
          if (!cancelled) setModel(null)
        })
    }
    refresh()
    if (!ws) return () => {
      cancelled = true
    }
    const off = ws.on('frame', (f: ServerEvent) => {
      if ((f as { type?: string }).type === 'model.changed') refresh()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [ws])

  const messageCount = messages.length
  // 粗略估 token 數：sum(各 block 文字長度) / 4
  const approxTokens = useMemo(() => {
    let total = 0
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === 'text' || b.kind === 'thinking') total += b.text.length
      }
    }
    return Math.round(total / 4)
  }, [messages])

  return (
    <Section title="Status">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">model</span>
          <span className="text-xs font-mono truncate" title={model ?? ''}>
            {model ?? '—'}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">permission</span>
          <span className="text-xs font-mono">{mode}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">state</span>
          <span className="text-xs font-mono">{turnState}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">messages</span>
          <span className="text-xs font-mono">{messageCount}</span>
        </div>
        <div className="flex flex-col col-span-2">
          <span className="text-xs text-muted-foreground">~ tokens（粗估）</span>
          <span className="text-xs font-mono">{approxTokens.toLocaleString()}</span>
        </div>
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
        {title}
      </h3>
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

/**
 * Header memory badge 用：輕量撈當前 project 的 memory 條目數，
 * 訂閱 `memory.itemsChanged` WS frame 自動刷新。null 代表尚未撈到（不顯示 badge）。
 *
 * 之所以在 ContextPanel 自己撈而不依賴 MemoryTab：MemoryTab 只在被展開時才掛載，
 * collapsed 狀態下沒人撈，header badge 也就拿不到數字。多一次小型 list 請求換
 * 永遠正確的 count。
 */
function useMemoryCount(projectId: string | null): number | null {
  const ws = useWsClient()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!projectId) {
      setCount(null)
      return
    }
    let cancelled = false
    const refetch = () => {
      api.memory
        .list(projectId)
        .then(({ entries }) => {
          if (!cancelled) setCount(entries.length)
        })
        .catch(() => {
          if (!cancelled) setCount(null)
        })
    }
    refetch()
    if (!ws) return () => {
      cancelled = true
    }
    const off = ws.on('frame', (f: ServerEvent) => {
      if (f.type === 'memory.itemsChanged' && (f as { projectId?: string }).projectId === projectId) {
        refetch()
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, ws])

  return count
}
