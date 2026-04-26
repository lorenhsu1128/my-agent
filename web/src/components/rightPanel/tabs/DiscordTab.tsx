/**
 * M-WEB-CLOSEOUT-11：Discord admin tab — 接 daemon /api/discord/* 後可從 web 操作。
 *
 * 行為：
 *   - status：read-only（enabled / running / botTag / counts）
 *   - bindings 列表 + 解除按鈕（unbind）
 *   - 「Bind current project」表單（手動輸入 cwd）
 *   - reload / restart 按鈕（restart 需二次確認）
 *   - 訂閱 WS `discord.statusChanged` 自動 refresh
 *   - LAN 內無認證警告 banner
 */
import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebDiscordStatus,
  type WebDiscordBinding,
} from '../../../api/client'
import { useWsClient } from '../../../hooks/useWsClient'

export function DiscordTab() {
  const [status, setStatus] = useState<WebDiscordStatus | null>(null)
  const [bindings, setBindings] = useState<WebDiscordBinding[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bindCwd, setBindCwd] = useState('')
  const [bindName, setBindName] = useState('')
  const [available, setAvailable] = useState<boolean>(true)
  const ws = useWsClient()

  async function refresh() {
    setError(null)
    try {
      const [s, b] = await Promise.all([
        api.discord.status(),
        api.discord.bindings(),
      ])
      setStatus(s)
      setBindings(b.bindings)
      setAvailable(true)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DISCORD_NOT_AVAILABLE') {
        setAvailable(false)
        return
      }
      setError(
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
  }, [])

  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (f.type === 'discord.statusChanged') {
        void refresh()
      }
    })
  }, [ws])

  async function action<T>(name: string, fn: () => Promise<T>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      setError(`${name} 失敗：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  if (!available) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Discord
        </span>
        <div className="bg-bg-tertiary border border-divider/50 rounded p-3 text-xs">
          Discord controller 未在 daemon 啟動。請編輯
          <code className="mx-1 text-text-secondary">
            ~/.my-agent/discord.json
          </code>
          設定 enabled / botToken 並重啟 daemon。
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs uppercase tracking-wide">
          Discord
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-muted hover:text-text-primary text-xs"
        >
          ⟳
        </button>
      </div>

      <div className="bg-status-idle/20 border border-status-idle/50 rounded p-2 text-xs text-text-secondary">
        ⚠ LAN 無認證模式：任何能連上此 web 的人都可變更 Discord 設定。
      </div>

      {error && <div className="text-status-dnd text-xs">⚠ {error}</div>}

      {status && (
        <div className="bg-bg-tertiary border border-divider/50 rounded p-2 flex flex-col gap-1 text-xs">
          <Row
            label="enabled"
            value={status.enabled ? 'true' : 'false'}
            tone={status.enabled ? 'online' : 'idle'}
          />
          <Row
            label="running"
            value={status.running ? 'connected' : 'stopped'}
            tone={status.running ? 'online' : 'dnd'}
          />
          {status.botTag && <Row label="bot" value={status.botTag} />}
          {status.guildId && <Row label="guildId" value={status.guildId} />}
          {status.homeChannelId && (
            <Row label="home channel" value={status.homeChannelId} />
          )}
          <Row
            label="counts"
            value={`whitelist=${status.whitelistUserCount}  projects=${status.projectCount}  bindings=${status.bindingCount}`}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-text-muted text-[10px] uppercase">
          Bindings ({bindings.length})
        </span>
        {bindings.length === 0 && (
          <div className="text-text-muted text-xs">(無 binding)</div>
        )}
        {bindings.map(b => (
          <div
            key={b.channelId}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-bg-tertiary border border-divider/50 text-xs"
          >
            <span className="text-text-muted w-20 truncate" title={b.channelId}>
              {b.channelId}
            </span>
            <span className="flex-1 truncate font-mono" title={b.cwd}>
              {b.cwd}
            </span>
            <button
              onClick={() =>
                void action('unbind', () => api.discord.unbind(b.cwd))
              }
              disabled={busy}
              className="px-2 py-0.5 rounded border border-divider hover:border-status-dnd hover:text-status-dnd disabled:opacity-50"
            >
              unbind
            </button>
          </div>
        ))}
      </div>

      <div className="bg-bg-tertiary border border-divider/50 rounded p-2 flex flex-col gap-2 text-xs">
        <span className="text-text-muted text-[10px] uppercase">
          Bind a project
        </span>
        <input
          type="text"
          value={bindCwd}
          onChange={e => setBindCwd(e.target.value)}
          placeholder="cwd（絕對路徑）"
          className="bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none font-mono"
        />
        <input
          type="text"
          value={bindName}
          onChange={e => setBindName(e.target.value)}
          placeholder="projectName（選填）"
          className="bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none"
        />
        <button
          onClick={() => {
            if (!bindCwd.trim()) return
            void action('bind', () =>
              api.discord.bind(bindCwd.trim(), bindName.trim() || undefined),
            ).then(() => {
              setBindCwd('')
              setBindName('')
            })
          }}
          disabled={busy || !bindCwd.trim()}
          className="px-3 py-1 rounded bg-brand hover:bg-brand-hover text-white disabled:opacity-50"
        >
          Bind
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => void action('reload', () => api.discord.reload())}
          disabled={busy}
          className="flex-1 px-3 py-1 rounded bg-bg-accent hover:bg-bg-floating text-text-secondary text-xs disabled:opacity-50"
          title="重讀 discord.json（不重啟連線）"
        >
          Reload config
        </button>
        <button
          onClick={() => {
            if (!confirm('確認要重啟 Discord gateway？短暫斷線後重連。')) return
            void action('restart', () => api.discord.restart())
          }}
          disabled={busy}
          className="flex-1 px-3 py-1 rounded bg-status-dnd/40 hover:bg-status-dnd/60 text-text-primary text-xs disabled:opacity-50"
          title="dispose + 重起 gateway（會短暫斷線）"
        >
          Restart gateway
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'online' | 'idle' | 'dnd'
}) {
  const color =
    tone === 'online'
      ? 'text-status-online'
      : tone === 'dnd'
        ? 'text-status-dnd'
        : tone === 'idle'
          ? 'text-status-idle'
          : 'text-text-secondary'
  return (
    <div className="flex items-center gap-2">
      <span className="text-text-muted w-24">{label}</span>
      <span className={`font-mono ${color}`}>{value}</span>
    </div>
  )
}
