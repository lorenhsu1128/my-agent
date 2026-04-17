// Background task entry for session review (self-improving loop).
// Surfaces the otherwise-invisible forked agent in the footer pill and
// Shift+Down dialog, following the same pattern as DreamTask.

import type { SetAppState, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type SessionReviewPhase = 'analyzing' | 'writing'

export type SessionReviewTaskState = TaskStateBase & {
  type: 'session_review'
  phase: SessionReviewPhase
  toolUsesReviewed: number
  skillDraftsCreated: string[]
  trajectoryWritten: boolean
}

export function isSessionReviewTask(
  task: unknown,
): task is SessionReviewTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'session_review'
  )
}

export function registerSessionReviewTask(
  setAppState: SetAppState,
  opts: { toolUsesReviewed: number },
): string {
  const id = generateTaskId('session_review')
  const task: SessionReviewTaskState = {
    ...createTaskStateBase(id, 'session_review', 'reviewing session'),
    type: 'session_review',
    status: 'running',
    phase: 'analyzing',
    toolUsesReviewed: opts.toolUsesReviewed,
    skillDraftsCreated: [],
    trajectoryWritten: false,
  }
  registerTask(task, setAppState)
  return id
}

export function completeSessionReviewTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<SessionReviewTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
  }))
}

export function failSessionReviewTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<SessionReviewTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
  }))
}
