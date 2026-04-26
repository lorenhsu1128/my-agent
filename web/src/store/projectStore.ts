/**
 * M-WEB project list state（zustand）。
 */
import { create } from 'zustand'
import type { WebProjectInfo } from '../api/types'

interface ProjectState {
  projects: Record<string, WebProjectInfo>
  selectedProjectId: string | null
  loaded: boolean
  loading: boolean
  loadError: string | null
  // actions
  setProjects(list: WebProjectInfo[]): void
  upsertProject(p: WebProjectInfo): void
  removeProject(projectId: string): void
  selectProject(projectId: string | null): void
  setLoading(b: boolean): void
  setError(err: string | null): void
}

export const useProjectStore = create<ProjectState>(set => ({
  projects: {},
  selectedProjectId: null,
  loaded: false,
  loading: false,
  loadError: null,
  setProjects: list =>
    set(() => {
      const map: Record<string, WebProjectInfo> = {}
      for (const p of list) map[p.projectId] = p
      return { projects: map, loaded: true, loading: false, loadError: null }
    }),
  upsertProject: p =>
    set(s => ({
      projects: { ...s.projects, [p.projectId]: p },
      loaded: true,
    })),
  removeProject: projectId =>
    set(s => {
      const next = { ...s.projects }
      delete next[projectId]
      return {
        projects: next,
        selectedProjectId:
          s.selectedProjectId === projectId ? null : s.selectedProjectId,
      }
    }),
  selectProject: projectId => set({ selectedProjectId: projectId }),
  setLoading: b => set({ loading: b }),
  setError: err => set({ loadError: err, loading: false }),
}))

export function listProjectsSorted(
  projects: Record<string, WebProjectInfo>,
): WebProjectInfo[] {
  return Object.values(projects).sort((a, b) => {
    // attached repl 排前面
    if (a.hasAttachedRepl !== b.hasAttachedRepl) {
      return a.hasAttachedRepl ? -1 : 1
    }
    // 名稱
    return a.name.localeCompare(b.name)
  })
}
