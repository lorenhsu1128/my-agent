/**
 * M-WEB-SLASH-D1：jsx-handoff 命令的中央 dispatcher。
 *
 * 監聽 useCommandDispatcherStore；有 current 時開 Dialog 顯示對應元件。
 * D1 階段所有 48 個 local-jsx 共用 GenericLocalJsxModal（顯示 metadata + TUI
 * fallback 提示）；D2 依命令 name 路由到分類 hint。
 *
 * 未來真正的 per-command React port（D-FULL）就在這個檔案的 switch / 註冊表
 * 內加 case；外部介面（Daemon → frame → store → dispatcher）不需要動。
 */
import { useCommandDispatcherStore } from '@/store/commandDispatcherStore'
import { GenericLocalJsxModal } from './GenericLocalJsxModal'

export function CommandDispatcher() {
  const current = useCommandDispatcherStore(s => s.current)
  const close = useCommandDispatcherStore(s => s.close)

  if (!current) return null

  // D-FULL 將在這裡按 name switch 出真實 React 元件；目前一律 generic。
  return (
    <GenericLocalJsxModal
      metadata={current.metadata}
      args={current.args}
      onClose={close}
    />
  )
}
