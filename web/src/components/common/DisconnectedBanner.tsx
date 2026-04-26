import { useWsStore } from '../../store/wsStore'

export function DisconnectedBanner() {
  const status = useWsStore(s => s.status)
  if (status === 'open' || status === 'connecting') return null
  const text =
    status === 'reconnecting' ? '⟳ 重新連線中…' : '⚠ 連線中斷'
  return (
    <div className="bg-status-dnd/20 text-status-dnd text-center text-sm py-1 border-b border-status-dnd/40">
      {text}
    </div>
  )
}
