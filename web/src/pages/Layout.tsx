import { useAppData } from '../hooks/useAppData'
import { ProjectList } from '../components/leftPanel/ProjectList'
import { ChatView } from '../components/chat/ChatView'
import { ContextPanelPlaceholder } from '../components/rightPanel/ContextPanelPlaceholder'
import { DisconnectedBanner } from '../components/common/DisconnectedBanner'
import { PermissionModal } from '../components/chat/PermissionModal'

export function Layout() {
  useAppData()
  return (
    <div className="h-full w-full flex flex-col">
      <DisconnectedBanner />
      <div className="flex-1 flex min-h-0">
        <ProjectList />
        <ChatView />
        <ContextPanelPlaceholder />
      </div>
      <PermissionModal />
    </div>
  )
}
