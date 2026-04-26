import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebDiscordStatus,
  type WebDiscordBinding,
} from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { RotateCw, AlertTriangle } from 'lucide-react'

export function DiscordTab() {
  const [status, setStatus] = useState<WebDiscordStatus | null>(null)
  const [bindings, setBindings] = useState<WebDiscordBinding[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bindCwd, setBindCwd] = useState('')
  const [bindName, setBindName] = useState('')
  const [available, setAvailable] = useState<boolean>(true)
  const [pendingRestart, setPendingRestart] = useState(false)
  const ws = useWsClient()

  async function refresh() {
    setError(null)
    try {
      const [s, b] = await Promise.all([api.discord.status(), api.discord.bindings()])
      setStatus(s); setBindings(b.bindings); setAvailable(true)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DISCORD_NOT_AVAILABLE') {
        setAvailable(false); return
      }
      setError(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    }
  }

  useEffect(() => { void refresh() }, [])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => { if (f.type === 'discord.statusChanged') void refresh() })
  }, [ws])

  async function action<T>(name: string, fn: () => Promise<T>) {
    setBusy(true); setError(null)
    try {
      await fn(); await refresh()
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : String(e)
      setError(`${name} 失敗：${msg}`)
    } finally { setBusy(false) }
  }

  if (!available) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Discord</span>
        <Card>
          <CardContent className="p-3 text-xs">
            Discord controller 未在 daemon 啟動。請編輯
            <code className="mx-1">~/.my-agent/discord.json</code>
            設定 enabled / botToken 並重啟 daemon。
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Discord</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void refresh()}>
          <RotateCw className="h-3 w-3" />
        </Button>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>LAN 無認證模式：任何能連上此 web 的人都可變更 Discord 設定。</AlertDescription>
      </Alert>

      {error && <div className="text-destructive text-xs">⚠ {error}</div>}

      {status && (
        <Card>
          <CardContent className="p-2 flex flex-col gap-1 text-xs">
            <Row label="enabled" value={status.enabled ? 'true' : 'false'} variant={status.enabled ? 'default' : 'outline'} />
            <Row label="running" value={status.running ? 'connected' : 'stopped'} variant={status.running ? 'default' : 'destructive'} />
            {status.botTag && <Row label="bot" value={status.botTag} />}
            {status.guildId && <Row label="guildId" value={status.guildId} />}
            {status.homeChannelId && <Row label="home channel" value={status.homeChannelId} />}
            <Row
              label="counts"
              value={`whitelist=${status.whitelistUserCount}  projects=${status.projectCount}  bindings=${status.bindingCount}`}
            />
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-[10px] uppercase">Bindings ({bindings.length})</span>
        {bindings.length === 0 && <div className="text-muted-foreground text-xs">(無 binding)</div>}
        {bindings.map(b => (
          <Card key={b.channelId}>
            <CardContent className="p-2 flex items-center gap-2 text-xs">
              <span className="text-muted-foreground w-20 truncate" title={b.channelId}>{b.channelId}</span>
              <span className="flex-1 truncate font-mono" title={b.cwd}>{b.cwd}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2"
                disabled={busy}
                onClick={() => void action('unbind', () => api.discord.unbind(b.cwd))}
              >
                unbind
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-2 flex flex-col gap-2 text-xs">
          <span className="text-muted-foreground text-[10px] uppercase">Bind a project</span>
          <Input
            value={bindCwd}
            onChange={e => setBindCwd(e.target.value)}
            placeholder="cwd（絕對路徑）"
            className="h-8 font-mono text-xs"
          />
          <Input
            value={bindName}
            onChange={e => setBindName(e.target.value)}
            placeholder="projectName（選填）"
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            disabled={busy || !bindCwd.trim()}
            onClick={() => {
              if (!bindCwd.trim()) return
              void action('bind', () =>
                api.discord.bind(bindCwd.trim(), bindName.trim() || undefined),
              ).then(() => { setBindCwd(''); setBindName('') })
            }}
          >
            Bind
          </Button>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={busy}
          onClick={() => void action('reload', () => api.discord.reload())}
          title="重讀 discord.json（不重啟連線）"
        >
          Reload config
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="flex-1"
          disabled={busy}
          onClick={() => setPendingRestart(true)}
          title="dispose + 重起 gateway（會短暫斷線）"
        >
          Restart gateway
        </Button>
      </div>

      <AlertDialog open={pendingRestart} onOpenChange={o => { if (!o) setPendingRestart(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重啟 Discord gateway？</AlertDialogTitle>
            <AlertDialogDescription>會短暫斷線後重連。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setPendingRestart(false)
                void action('restart', () => api.discord.restart())
              }}
            >
              重啟
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Row({
  label,
  value,
  variant,
}: {
  label: string
  value: string
  variant?: 'default' | 'outline' | 'destructive'
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-24">{label}</span>
      {variant ? (
        <Badge variant={variant} className="font-mono">{value}</Badge>
      ) : (
        <span className="font-mono">{value}</span>
      )}
    </div>
  )
}
