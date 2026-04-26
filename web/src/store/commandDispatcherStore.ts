/**
 * M-WEB-SLASH-D1：CommandDispatcher 狀態管理。
 *
 * Daemon 回 slashCommand.executeResult kind='jsx-handoff' 時，ChatView 把命令
 * metadata 寫入此 store；CommandDispatcher 元件監聽 store 開 Modal。
 *
 * D1 階段所有 48 個 local-jsx 共用一個 GenericLocalJsxModal（顯示命令 metadata
 * + 「TUI 端完整支援，web 端目前 stub」說明）。D2 加 per-category hint。
 * 完整 React port（每個命令各自的互動 UI）走後續 milestone M-WEB-SLASH-D-FULL。
 */
import { create } from 'zustand'
import type { WebSlashCommandMetadata } from '../api/client'

export interface DispatchedCommand {
  metadata: WebSlashCommandMetadata
  args: string
  /** 收到 result 的時間戳（給 dedupe / debounce 用） */
  receivedAt: number
}

interface CommandDispatcherState {
  current: DispatchedCommand | null
  open(metadata: WebSlashCommandMetadata, args: string): void
  close(): void
}

export const useCommandDispatcherStore = create<CommandDispatcherState>(
  set => ({
    current: null,
    open: (metadata, args) =>
      set({ current: { metadata, args, receivedAt: Date.now() } }),
    close: () => set({ current: null }),
  }),
)
