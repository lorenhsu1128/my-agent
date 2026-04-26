import { useAppData } from '../hooks/useAppData'
import { ProjectList } from '../components/leftPanel/ProjectList'
import { ChatView } from '../components/chat/ChatView'
import { ContextPanel } from '../components/rightPanel/ContextPanel'
import { DisconnectedBanner } from '../components/common/DisconnectedBanner'
import { PermissionModal } from '../components/chat/PermissionModal'
import { CommandDispatcher } from '../components/slash/CommandDispatcher'
import { ThemeToggle } from '../components/theme-toggle'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'

export function Layout() {
  useAppData()
  return (
    <div className="h-full w-full flex flex-col bg-background text-foreground">
      <DisconnectedBanner />
      <header className="h-12 flex items-center justify-between px-4 border-b shrink-0">
        <span className="font-semibold tracking-tight">my-agent</span>
        <ThemeToggle />
      </header>
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="my-agent-web-layout">
          <ResizablePanel defaultSize={20} minSize={15} maxSize={35}>
            <ProjectList />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={55} minSize={30}>
            <ChatView />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={25} minSize={18} maxSize={40}>
            <ContextPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <PermissionModal />
      <CommandDispatcher />
      <Toaster />
    </div>
  )
}
