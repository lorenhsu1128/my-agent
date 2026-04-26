import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebWatchdogConfig,
  type WebSlotInfo,
} from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'

export function LlamacppTab() {
  const [cfg, setCfg] = useState<WebWatchdogConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ws = useWsClient()

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const { config } = await api.llamacpp.getWatchdog()
      setCfg(config)
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (f.type === 'llamacpp.configChanged') {
        void refresh()
      }
    })
  }, [ws])

  async function update(next: WebWatchdogConfig) {
    setBusy(true)
    setError(null)
    try {
      await api.llamacpp.setWatchdog(next)
      setCfg(next)
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setBusy(false)
    }
  }

  if (loading && !cfg) {
    return <div className="text-text-muted text-xs">載入中…</div>
  }
  if (!cfg) {
    return (
      <div className="text-status-dnd text-xs">⚠ {error ?? 'unknown error'}</div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Llamacpp Watchdog
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-muted hover:text-text-primary text-xs"
        >
          ⟳
        </button>
      </div>
      {error && <div className="text-status-dnd text-xs">⚠ {error}</div>}

      <Toggle
        label="Master enable"
        checked={cfg.enabled}
        disabled={busy}
        onChange={v => void update({ ...cfg, enabled: v })}
        hint="主開關；關掉則所有 layer 都不生效（即使 layer.enabled=true）"
      />
      <NestedToggle
        title="A. Inter-chunk"
        layerEnabled={cfg.interChunk.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v =>
          void update({ ...cfg, interChunk: { ...cfg.interChunk, enabled: v } })
        }
      >
        <NumberField
          label="gapMs"
          value={cfg.interChunk.gapMs}
          disabled={busy}
          onChange={v =>
            void update({
              ...cfg,
              interChunk: { ...cfg.interChunk, gapMs: v },
            })
          }
        />
      </NestedToggle>
      <NestedToggle
        title="B. Reasoning"
        layerEnabled={cfg.reasoning.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v =>
          void update({ ...cfg, reasoning: { ...cfg.reasoning, enabled: v } })
        }
      >
        <NumberField
          label="blockMs"
          value={cfg.reasoning.blockMs}
          disabled={busy}
          onChange={v =>
            void update({
              ...cfg,
              reasoning: { ...cfg.reasoning, blockMs: v },
            })
          }
        />
      </NestedToggle>
      <NestedToggle
        title="C. Token cap"
        layerEnabled={cfg.tokenCap.enabled}
        masterEnabled={cfg.enabled}
        disabled={busy}
        onLayerChange={v =>
          void update({ ...cfg, tokenCap: { ...cfg.tokenCap, enabled: v } })
        }
      >
        <NumberField
          label="default"
          value={cfg.tokenCap.default}
          disabled={busy}
          onChange={v =>
            void update({ ...cfg, tokenCap: { ...cfg.tokenCap, default: v } })
          }
        />
        <NumberField
          label="background"
          value={cfg.tokenCap.background}
          disabled={busy}
          onChange={v =>
            void update({ ...cfg, tokenCap: { ...cfg.tokenCap, background: v } })
          }
        />
      </NestedToggle>

      <SlotsPanel />
    </div>
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
      setAvailable(r.available)
      setSlots(r.slots)
      setReason(r.reason ?? null)
    } catch (e) {
      setAvailable(false)
      setReason(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
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
      const msg =
        e instanceof ApiError
          ? e.code === 'SLOT_ERASE_UNSUPPORTED'
            ? 'server 未啟用 slot cancel — 請以 --slot-save-path 重啟 llama-server'
            : `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      setFlash({ text: msg, tone: 'error' })
    } finally {
      setBusyId(null)
      setTimeout(() => setFlash(null), 4000)
    }
  }

  return (
    <div className="bg-bg-tertiary border border-divider/50 rounded p-2 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Slot inspector
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-muted hover:text-text-primary text-xs"
          title="refresh"
        >
          ⟳
        </button>
      </div>

      {available === null && (
        <div className="text-text-muted text-xs">載入中…</div>
      )}
      {available === false && (
        <div className="text-text-muted text-xs">
          slot inspector unavailable
          {reason && <span className="block mt-1">原因：{reason}</span>}
        </div>
      )}
      {available && slots.length === 0 && (
        <div className="text-text-muted text-xs">(無 slot 資料)</div>
      )}
      {available && slots.length > 0 && (
        <div className="flex flex-col gap-1">
          {slots.map(s => {
            const stateColor = s.isProcessing ? 'text-status-idle' : 'text-status-online'
            const stateLabel = s.isProcessing ? 'processing' : 'idle'
            const reasoningHint = s.isProcessing && s.nDecoded > 20000
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 text-xs font-mono"
              >
                <span className="text-text-muted w-12">slot {s.id}</span>
                <span className={`${stateColor} w-20`}>{stateLabel}</span>
                <span className="text-text-muted">decoded</span>
                <span className="w-16 text-right">{s.nDecoded}</span>
                <span className="text-text-muted">remain</span>
                <span className="w-16 text-right">{s.nRemain}</span>
                {reasoningHint && (
                  <span className="text-status-dnd">← reasoning loop?</span>
                )}
                <button
                  onClick={() => void handleErase(s.id)}
                  disabled={busyId === s.id}
                  className="ml-auto px-2 py-0.5 rounded border border-divider hover:border-status-dnd hover:text-status-dnd disabled:opacity-50"
                  title="erase slot（需 server 帶 --slot-save-path）"
                >
                  erase
                </button>
              </div>
            )
          })}
        </div>
      )}
      {flash && (
        <div
          className={
            flash.tone === 'error'
              ? 'text-status-dnd text-xs'
              : 'text-status-online text-xs'
          }
        >
          {flash.text}
        </div>
      )}
    </div>
  )
}

function Toggle({
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
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          className="accent-brand"
        />
        <span className="text-sm">{label}</span>
      </label>
      {hint && <span className="text-text-muted text-xs">{hint}</span>}
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
    <div className="bg-bg-tertiary border border-divider/50 rounded p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={layerEnabled}
          disabled={disabled}
          onChange={e => onLayerChange(e.target.checked)}
          className="accent-brand"
        />
        <span className="text-sm font-semibold">{title}</span>
        {effective && (
          <span className="text-status-online text-[10px]">effective</span>
        )}
      </div>
      <div className="ml-5 flex flex-col gap-1">{children}</div>
    </div>
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
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-text-muted w-20">{label}</span>
      <input
        type="number"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft)
          if (Number.isFinite(n) && n !== value) onChange(n)
        }}
        className="bg-bg-floating text-text-primary px-2 py-0.5 rounded border border-divider focus:border-brand outline-none w-24 font-mono"
      />
    </div>
  )
}
