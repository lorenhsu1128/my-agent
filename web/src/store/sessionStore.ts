/**
 * M-WEB per-project session list state。
 */
import { create } from 'zustand'
import type { WebSessionInfo } from '../api/types'

interface SessionState {
  /** projectId → sessions */
  byProject: Record<string, WebSessionInfo[]>
  /** projectId → activeSessionId（伺服器回的當前 session）。 */
  activeSessionByProject: Record<string, string>
  /** projectId → 使用者選的 session（可不同於 active）。 */
  selectedSessionByProject: Record<string, string>
  /** M-WEB-22：projectId → sessionId → 是否正在 backfill（給 ChatView 顯示 spinner）。 */
  loadingMessagesByProject: Record<string, Record<string, boolean>>
  /** M-WEB-22：projectId → sessionId → backfill 失敗訊息（null 表 OK）。 */
  errorMessagesByProject: Record<string, Record<string, string | null>>
  setSessions(
    projectId: string,
    sessions: WebSessionInfo[],
    activeSessionId: string,
  ): void
  selectSession(projectId: string, sessionId: string): void
  setMessagesLoading(
    projectId: string,
    sessionId: string,
    loading: boolean,
  ): void
  setMessagesError(
    projectId: string,
    sessionId: string,
    error: string | null,
  ): void
}

export const useSessionStore = create<SessionState>(set => ({
  byProject: {},
  activeSessionByProject: {},
  selectedSessionByProject: {},
  loadingMessagesByProject: {},
  errorMessagesByProject: {},
  setSessions: (projectId, sessions, activeSessionId) =>
    set(s => ({
      byProject: { ...s.byProject, [projectId]: sessions },
      activeSessionByProject: {
        ...s.activeSessionByProject,
        [projectId]: activeSessionId,
      },
      selectedSessionByProject: {
        ...s.selectedSessionByProject,
        // 預設選 active
        [projectId]:
          s.selectedSessionByProject[projectId] ?? activeSessionId,
      },
    })),
  selectSession: (projectId, sessionId) =>
    set(s => ({
      selectedSessionByProject: {
        ...s.selectedSessionByProject,
        [projectId]: sessionId,
      },
    })),
  setMessagesLoading: (projectId, sessionId, loading) =>
    set(s => {
      const projMap = { ...(s.loadingMessagesByProject[projectId] ?? {}) }
      if (loading) projMap[sessionId] = true
      else delete projMap[sessionId]
      return {
        loadingMessagesByProject: {
          ...s.loadingMessagesByProject,
          [projectId]: projMap,
        },
      }
    }),
  setMessagesError: (projectId, sessionId, error) =>
    set(s => {
      const projMap = { ...(s.errorMessagesByProject[projectId] ?? {}) }
      if (error) projMap[sessionId] = error
      else delete projMap[sessionId]
      return {
        errorMessagesByProject: {
          ...s.errorMessagesByProject,
          [projectId]: projMap,
        },
      }
    }),
}))
