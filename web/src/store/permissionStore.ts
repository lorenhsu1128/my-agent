/**
 * M-WEB-13：per-project pending permission state。
 *
 * permission.pending 進來 → set；permission.resolved 進來 → clear（first-wins
 * race：TUI 或 Discord 任一端先 respond 都會觸發 daemon 廣播 resolved）。
 */
import { create } from 'zustand'

export interface PendingPermission {
  projectId: string
  toolUseID: string
  toolName: string
  input: unknown
  riskLevel?: string
  description?: string
  affectedPaths?: string[]
  sourceClientId?: string
  receivedAt: number
}

interface PermissionState {
  /** projectId → pending（Phase 2 一個 project 同時最多一個 pending） */
  pendingByProject: Record<string, PendingPermission>
  /** 從 receivedAt 反向看每 project mode 變化（顯示 status bar 用）。 */
  modeByProject: Record<string, string>
  setPending(p: PendingPermission): void
  clearPending(projectId: string, toolUseID: string): void
  setMode(projectId: string, mode: string): void
}

export const usePermissionStore = create<PermissionState>(set => ({
  pendingByProject: {},
  modeByProject: {},
  setPending: p =>
    set(s => ({
      pendingByProject: { ...s.pendingByProject, [p.projectId]: p },
    })),
  clearPending: (projectId, toolUseID) =>
    set(s => {
      const cur = s.pendingByProject[projectId]
      if (!cur || cur.toolUseID !== toolUseID) return s
      const next = { ...s.pendingByProject }
      delete next[projectId]
      return { pendingByProject: next }
    }),
  setMode: (projectId, mode) =>
    set(s => ({ modeByProject: { ...s.modeByProject, [projectId]: mode } })),
}))
