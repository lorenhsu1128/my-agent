/**
 * M-WEB-17：Discord tab — Phase 3 minimal（read-only 提示 + 引導去 TUI 設定）。
 *
 * Phase 3.5 / Phase 4 會接 daemon admin RPC：bind/unbind/whitelist。目前 web
 * 沒有 thin-client WS（與 daemon 的對話是 web /ws 不是 /sessions），無法直接
 * 呼叫 discord admin RPC；需要 REST 包一層先。
 */
export function DiscordTab() {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <span className="text-text-muted text-xs uppercase tracking-wide">
        Discord
      </span>
      <div className="bg-bg-tertiary border border-divider/50 rounded p-3 text-xs flex flex-col gap-2">
        <p className="text-text-secondary">
          Discord gateway 由 daemon 統一管理。設定請編輯
          <code className="text-text-primary mx-1">~/.my-agent/discord.jsonc</code>
          後重啟 daemon 或在 REPL 內使用：
        </p>
        <ul className="list-disc pl-5 text-text-muted space-y-1">
          <li>
            <code className="text-text-secondary">/discord-bind</code> — 為當前
            project 建立 channel
          </li>
          <li>
            <code className="text-text-secondary">/discord-unbind</code> —
            解除 binding
          </li>
          <li>
            <code className="text-text-secondary">/discord-whitelist-add</code>
            / <code className="text-text-secondary">remove</code> — 管理白名單
          </li>
          <li>
            <code className="text-text-secondary">/discord-invite</code> —
            產生邀請連結
          </li>
        </ul>
        <p className="text-text-muted">
          Web 直接管理 Discord 的 admin RPC 待 M-WEB-17b 接上。
        </p>
      </div>
    </div>
  )
}
