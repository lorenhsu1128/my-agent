import { create } from 'zustand'
import type { WebCronTask } from '../api/client'

interface CronState {
  byProject: Record<string, WebCronTask[]>
  loadingByProject: Record<string, boolean>
  errorByProject: Record<string, string | null>
  setTasks(projectId: string, tasks: WebCronTask[]): void
  setLoading(projectId: string, loading: boolean): void
  setError(projectId: string, error: string | null): void
}

export const useCronStore = create<CronState>(set => ({
  byProject: {},
  loadingByProject: {},
  errorByProject: {},
  setTasks: (projectId, tasks) =>
    set(s => ({
      byProject: { ...s.byProject, [projectId]: tasks },
      loadingByProject: { ...s.loadingByProject, [projectId]: false },
      errorByProject: { ...s.errorByProject, [projectId]: null },
    })),
  setLoading: (projectId, loading) =>
    set(s => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: loading },
    })),
  setError: (projectId, error) =>
    set(s => ({
      errorByProject: { ...s.errorByProject, [projectId]: error },
      loadingByProject: { ...s.loadingByProject, [projectId]: false },
    })),
}))
