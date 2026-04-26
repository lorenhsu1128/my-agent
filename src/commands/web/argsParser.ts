/**
 * M-WEB-7：`/web` 子指令 args parser。
 *
 * 支援：
 *   /web                  → TUI（暫無，args-mode 走 status）
 *   /web start            → daemon RPC web.control op=start
 *   /web stop             → daemon RPC web.control op=stop
 *   /web status           → daemon RPC web.control op=status
 *   /web open             → 在系統預設瀏覽器開首個 URL
 *   /web qr               → 印 ASCII QR code
 *   /web help             → 顯示幫助
 */

export type ParsedWebArgs =
  | { kind: 'tui' }
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'open' }
  | { kind: 'qr' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseWebArgs(raw: string): ParsedWebArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'tui' }
  const parts = trimmed.split(/\s+/)
  const head = parts[0]?.toLowerCase()
  switch (head) {
    case 'start':
      return { kind: 'start' }
    case 'stop':
      return { kind: 'stop' }
    case 'status':
      return { kind: 'status' }
    case 'open':
      return { kind: 'open' }
    case 'qr':
      return { kind: 'qr' }
    case 'help':
    case '-h':
    case '--help':
      return { kind: 'help' }
    default:
      return { kind: 'error', message: `unknown subcommand: ${head}` }
  }
}

export const HELP_TEXT = `/web — Web UI 控制（M-WEB）

子指令：
  /web start    啟動 web HTTP server（依 ~/.my-agent/web.jsonc 的 port / bindHost）
  /web stop     停止 web server
  /web status   顯示當前狀態（running / port / 連線數 / URL 清單）
  /web open     在系統瀏覽器開啟第一個 URL（需 running）
  /web qr       印 ASCII QR code 方便手機掃（需 running）
  /web help     此說明

設定檔：~/.my-agent/web.jsonc
  enabled       boolean（預設 false；改 true 才能用）
  autoStart     boolean（預設 true；daemon 啟動時自動 start）
  port          number （預設 9090；衝突自動 +1）
  bindHost      string （預設 "0.0.0.0"，LAN 全開；改 "127.0.0.1" 限本機）
  devProxyUrl   string?（dev 模式反向 proxy 到 vite，例 "http://127.0.0.1:5173"）

Phase 1（目前）：基礎 server + 靜態檔 + WS infra（無 UI）
Phase 2+：完整 chat / 三欄式 UI（M-WEB-8 起）
`
