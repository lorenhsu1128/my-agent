/**
 * M-WEB-SLASH-C1：跨 component 共享的 UI 狀態（目前只放右欄 active tab）。
 *
 * 用 zustand 的目的是讓 ChatView 收到 slashCommand.executeResult kind='web-redirect'
 * 時可以把 ContextPanel 的 active tab 切過去（cron/memory/llamacpp/discord）。
 */
import { create } from 'zustand'

export type ContextTabId =
  | 'overview'
  | 'cron'
  | 'memory'
  | 'llamacpp'
  | 'discord'
  | 'permissions'

/** Accordion 展開值：`''` 代表全收合（Radix single-mode 無展開項時的值）。 */
export type ContextSection = ContextTabId | ''

interface UiState {
  rightTab: ContextSection
  setRightTab(tab: ContextSection): void
}

export const useUiStore = create<UiState>(set => ({
  rightTab: '',
  setRightTab: tab => set({ rightTab: tab }),
}))
