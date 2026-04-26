import { useWsStore } from '../../store/wsStore'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, RotateCw } from 'lucide-react'

export function DisconnectedBanner() {
  const status = useWsStore(s => s.status)
  if (status === 'open' || status === 'connecting') return null
  const reconnecting = status === 'reconnecting'
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0 py-2">
      {reconnecting ? <RotateCw className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />}
      <AlertDescription>
        {reconnecting ? '重新連線中…' : '連線中斷'}
      </AlertDescription>
    </Alert>
  )
}
