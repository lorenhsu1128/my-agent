import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebWatchdogConfig,
  type WebSlotInfo,
} from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RotateCw } from 'lucide-react'

export function LlamacppTab() {
  const [cfg, setCfg] = useState<WebWatchdogConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ws = useWsClient()

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const { config } = await api.llamacpp.getWatchdog()
      setCfg(config)
    } catch (e) {
      setError(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    } finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (f.type === 'llamacpp.configChanged') void refresh()
    })
  }, [ws])

  async function update(next: WebWatchdogConfig) {
    setBusy(true); setError(null)
    try {
      await api.llamacpp.setWatchdog(next)
      setCfg(next)
    } catch (e) {
      setError(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    } finally { setBusy(false) }
  }

  if (loading && !cfg) return <div className="text-muted-foreground text-xs">載入中…</div>
  if (!cfg) return <div className="text-destructive text-xs">⚠ {error ?? 'unknown error'}</div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Llamacpp Watchdog</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void refresh()}>
          <RotateCw className="h-3 w-3" />
        </Button>
      </div>
      {error && <div className="text-destructive text-xs">⚠ {error}</div>}

      <ToggleRow
        label="Master enable"
        checked={cfg.enabled}
        disabled={busy}
        onChange={v => void update({ ...cfg, enabled: v })}
        hint="主開關；關掉則所有 layer 都不生效"
      />
      <NestedToggle
        title="A. Inter-chunk"
        layerEnabled={cfg.interChunk.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v => void update({ ...cfg, interChunk: { ...cfg.interChunk, enabled: v } })}
      >
        <NumberField
          label="gapMs"
          value={cfg.interChunk.gapMs}
          disabled={busy}
          onChange={v => void update({ ...cfg, interChunk: { ...cfg.interChunk, gapMs: v } })}
        />
      </NestedToggle>
      <NestedToggle
        title="B. Reasoning"
        layerEnabled={cfg.reasoning.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v => void update({ ...cfg, reasoning: { ...cfg.reasoning, enabled: v } })}
      >
        <NumberField
          label="blockMs"
          value={cfg.reasoning.blockMs}
          disabled={busy}
          onChange={v => void update({ ...cfg, reasoning: { ...cfg.reasoning, blockMs: v } })}
        />
      </NestedToggle>
      <NestedToggle
        title="C. Token cap"
        layerEnabled={cfg.tokenCap.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v => void update({ ...cfg, tokenCap: { ...cfg.tokenCap, enabled: v } })}
      >
        <NumberField
          label="default"
          value={cfg.tokenCap.default}
          disabled={busy}
          onChange={v => void update({ ...cfg, tokenCap: { ...cfg.tokenCap, default: v } })}
        />
        <NumberField
          label="background"
          value={cfg.tokenCap.background}
          disabled={busy}
          onChange={v => void update({ ...cfg, tokenCap: { ...cfg.tokenCap, background: v } })}
        />
      </NestedToggle>

      <EndpointsPanel />
      <RoutingPanel />
      <SlotsPanel />
    </div>
  )
}

// M-LLAMACPP-REMOTE：Endpoints card — local read-only + remote 編輯 + 連線測試
function EndpointsPanel() {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof api.llamacpp.getEndpoints>
  > | null>(null)
  const [draft, setDraft] = useState<{
    enabled: boolean
    baseUrl: string
    model: string
    apiKeyInput: string
    contextSize: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<
    { text: string; tone: 'info' | 'error' } | null
  >(null)
  const ws = useWsClient()

  async function refresh() {
    try {
      const r = await api.llamacpp.getEndpoints()
      setData(r)
      setDraft({
        enabled: r.remote.enabled,
        baseUrl: r.remote.baseUrl,
        model: r.remote.model,
        apiKeyInput: '', // 永遠空白；保留現有用戶可空白送 / 改新值
        contextSize: r.remote.contextSize,
      })
    } catch (e) {
      setFlash({
        text: e instanceof Error ? e.message : String(e),
        tone: 'error',
      })
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (
        f.type === 'llamacpp.configChanged' &&
        (f.changedSection === 'remote' ||
          f.changedSection === undefined)
      )
        void refresh()
    })
  }, [ws])

  if (!data || !draft) return null

  const apiKeyMasked = data.remote.apiKey ?? ''
  const isDirty =
    draft.enabled !== data.remote.enabled ||
    draft.baseUrl !== data.remote.baseUrl ||
    draft.model !== data.remote.model ||
    draft.contextSize !== data.remote.contextSize ||
    draft.apiKeyInput.length > 0

  async function save() {
    setBusy(true)
    try {
      await api.llamacpp.setRemote({
        enabled: draft!.enabled,
        baseUrl: draft!.baseUrl,
        model: draft!.model,
        apiKey:
          draft!.apiKeyInput.length > 0 ? draft!.apiKeyInput : undefined,
        contextSize: draft!.contextSize,
      })
      setFlash({ text: '已寫入 remote 區塊', tone: 'info' })
      await refresh()
    } catch (e) {
      setFlash({
        text: e instanceof Error ? e.message : String(e),
        tone: 'error',
      })
    } finally {
      setBusy(false)
      setTimeout(() => setFlash(null), 4000)
    }
  }

  async function testConn() {
    setBusy(true)
    try {
      const r = await api.llamacpp.testRemote({
        baseUrl: draft!.baseUrl,
        apiKey:
          draft!.apiKeyInput.length > 0 ? draft!.apiKeyInput : undefined,
      })
      if (r.ok) {
        setFlash({
          text: `OK · ${r.models.length} models${r.models.length > 0 ? `: ${r.models.slice(0, 3).join(', ')}${r.models.length > 3 ? '…' : ''}` : ''}`,
          tone: 'info',
        })
      } else {
        setFlash({
          text: `失敗：${(r as { error: string }).error}`,
          tone: 'error',
        })
      }
    } catch (e) {
      setFlash({
        text: e instanceof Error ? e.message : String(e),
        tone: 'error',
      })
    } finally {
      setBusy(false)
      setTimeout(() => setFlash(null), 6000)
    }
  }

  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Endpoints
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => void refresh()}
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          local · {data.local.baseUrl} · {data.local.model}
        </div>
        <div className="border-t my-1" />
        <div className="flex items-center justify-between">
          <Label className="text-xs">remote enabled</Label>
          <Switch
            checked={draft.enabled}
            disabled={busy}
            onCheckedChange={v => setDraft(d => (d ? { ...d, enabled: v } : d))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">baseUrl</Label>
          <Input
            value={draft.baseUrl}
            disabled={busy}
            onChange={e =>
              setDraft(d => (d ? { ...d, baseUrl: e.target.value } : d))
            }
            placeholder="http://192.168.1.10:8080/v1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">model</Label>
          <Input
            value={draft.model}
            disabled={busy}
            onChange={e =>
              setDraft(d => (d ? { ...d, model: e.target.value } : d))
            }
            placeholder="qwen3.5-32b"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">
            apiKey {apiKeyMasked && <span className="text-muted-foreground">(目前：{apiKeyMasked}；留空 = 不變更)</span>}
          </Label>
          <Input
            type="password"
            value={draft.apiKeyInput}
            disabled={busy}
            onChange={e =>
              setDraft(d =>
                d ? { ...d, apiKeyInput: e.target.value } : d,
              )
            }
            placeholder={apiKeyMasked ? '輸入新 key 才會覆蓋' : 'sk-...（選填）'}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">contextSize</Label>
          <Input
            type="number"
            value={draft.contextSize}
            disabled={busy}
            onChange={e =>
              setDraft(d =>
                d ? { ...d, contextSize: Number(e.target.value) || 0 } : d,
              )
            }
          />
        </div>
        <div className="flex gap-2 mt-1">
          <Button
            size="sm"
            disabled={busy || !isDirty}
            onClick={() => void save()}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !draft.baseUrl}
            onClick={() => void testConn()}
          >
            Test
          </Button>
        </div>
        {flash && (
          <div
            className={
              flash.tone === 'error'
                ? 'text-destructive text-xs'
                : 'text-xs text-muted-foreground'
            }
          >
            {flash.text}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// M-LLAMACPP-REMOTE：Routing card — 5 callsite × local|remote select
function RoutingPanel() {
  const CALLSITES: ReadonlyArray<
    'turn' | 'sideQuery' | 'memoryPrefetch' | 'background' | 'vision'
  > = ['turn', 'sideQuery', 'memoryPrefetch', 'background', 'vision']
  const [routing, setRouting] = useState<Record<string, 'local' | 'remote'> | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<
    { text: string; tone: 'info' | 'error' } | null
  >(null)
  const ws = useWsClient()

  async function refresh() {
    try {
      const r = await api.llamacpp.getEndpoints()
      setRouting(r.routing)
    } catch (e) {
      setFlash({
        text: e instanceof Error ? e.message : String(e),
        tone: 'error',
      })
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (
        f.type === 'llamacpp.configChanged' &&
        (f.changedSection === 'routing' ||
          f.changedSection === undefined)
      )
        void refresh()
    })
  }, [ws])

  async function update(callsite: string, value: 'local' | 'remote') {
    if (!routing) return
    const next = { ...routing, [callsite]: value }
    setBusy(true)
    try {
      await api.llamacpp.setRouting(next)
      setRouting(next)
      setFlash({ text: `已更新 routing.${callsite}=${value}`, tone: 'info' })
    } catch (e) {
      setFlash({
        text: e instanceof Error ? e.message : String(e),
        tone: 'error',
      })
    } finally {
      setBusy(false)
      setTimeout(() => setFlash(null), 4000)
    }
  }

  if (!routing) return null

  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Routing
          </span>
        </div>
        {CALLSITES.map(cs => (
          <div key={cs} className="flex items-center justify-between gap-2">
            <Label className="text-xs font-mono">{cs}</Label>
            <Select
              value={routing[cs] ?? 'local'}
              disabled={busy}
              onValueChange={v => void update(cs, v as 'local' | 'remote')}
            >
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">→ local</SelectItem>
                <SelectItem value="remote">→ remote</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
        {flash && (
          <div
            className={
              flash.tone === 'error'
                ? 'text-destructive text-xs'
                : 'text-xs text-muted-foreground'
            }
          >
            {flash.text}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SlotsPanel() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [slots, setSlots] = useState<WebSlotInfo[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [flash, setFlash] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)

  async function refresh() {
    try {
      const r = await api.llamacpp.getSlots()
      setAvailable(r.available); setSlots(r.slots); setReason(r.reason ?? null)
    } catch (e) {
      setAvailable(false)
      setReason(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    }
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  async function handleErase(id: number) {
    setBusyId(id)
    try {
      await api.llamacpp.eraseSlot(id)
      setFlash({ text: `已送 erase slot ${id}`, tone: 'info' })
      void refresh()
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.code === 'SLOT_ERASE_UNSUPPORTED'
          ? 'server 未啟用 slot cancel — 請以 --slot-save-path 重啟 llama-server'
          : `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : String(e)
      setFlash({ text: msg, tone: 'error' })
    } finally {
      setBusyId(null)
      setTimeout(() => setFlash(null), 4000)
    }
  }

  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">Slot inspector</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void refresh()}>
            <RotateCw className="h-3 w-3" />
          </Button>
        </div>
        {available === null && <div className="text-muted-foreground text-xs">載入中…</div>}
        {available === false && (
          <div className="text-muted-foreground text-xs">
            slot inspector unavailable
            {reason && <span className="block mt-1">原因：{reason}</span>}
          </div>
        )}
        {available && slots.length === 0 && <div className="text-muted-foreground text-xs">(無 slot 資料)</div>}
        {available && slots.length > 0 && (
          <div className="flex flex-col gap-1">
            {slots.map(s => {
              const reasoningHint = s.isProcessing && s.nDecoded > 20000
              return (
                <div key={s.id} className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-muted-foreground w-12">slot {s.id}</span>
                  <Badge variant={s.isProcessing ? 'outline' : 'secondary'} className="w-20 justify-center">
                    {s.isProcessing ? 'processing' : 'idle'}
                  </Badge>
                  <span className="text-muted-foreground">decoded</span>
                  <span className="w-16 text-right">{s.nDecoded}</span>
                  <span className="text-muted-foreground">remain</span>
                  <span className="w-16 text-right">{s.nRemain}</span>
                  {reasoningHint && <span className="text-destructive">← reasoning loop?</span>}
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-6 px-2"
                    onClick={() => void handleErase(s.id)}
                    disabled={busyId === s.id}
                  >
                    erase
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        {flash && (
          <div className={flash.tone === 'error' ? 'text-destructive text-xs' : 'text-[hsl(var(--chart-3))] text-xs'}>
            {flash.text}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <Label className="text-sm">{label}</Label>
      </div>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  )
}

function NestedToggle({
  title,
  layerEnabled,
  masterEnabled,
  disabled,
  onLayerChange,
  children,
}: {
  title: string
  layerEnabled: boolean
  masterEnabled: boolean
  disabled?: boolean
  onLayerChange: (v: boolean) => void
  children: React.ReactNode
}) {
  const effective = masterEnabled && layerEnabled
  return (
    <Card>
      <CardContent className="p-2 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch checked={layerEnabled} disabled={disabled} onCheckedChange={onLayerChange} />
          <Label className="text-sm font-semibold">{title}</Label>
          {effective && <Badge variant="secondary" className="text-[10px]">effective</Badge>}
        </div>
        <div className="ml-9 flex flex-col gap-1">{children}</div>
      </CardContent>
    </Card>
  )
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <div className="flex items-center gap-2 text-xs">
      <Label className="text-muted-foreground w-20">{label}</Label>
      <Input
        type="number"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft)
          if (Number.isFinite(n) && n !== value) onChange(n)
        }}
        className="h-7 w-24 font-mono text-xs"
      />
    </div>
  )
}
