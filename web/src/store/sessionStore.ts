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
  setSessions(
    projectId: string,
    sessions: WebSessionInfo[],
    activeSessionId: string,
  ): void
  selectSession(projectId: string, sessionId: string): void
}

export const useSessionStore = create<SessionState>(set => ({
  byProject: {},
  activeSessionByProject: {},
  selectedSessionByProject: {},
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
}))
