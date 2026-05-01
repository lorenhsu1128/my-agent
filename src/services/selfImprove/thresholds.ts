// Centralized threshold reader for the M6 Self-Improving Loop.
//
// Priority (consistent with autoDreamEnabled pattern):
//   1. User settings (selfImproveThresholds.X in settings.json) ← highest
//   2. GrowthBook (only for autoDreamMinHours/MinSessions via tengu_onyx_plover)
//   3. Hardcoded DEFAULTS ← lowest

import { getInitialSettings } from '../../utils/settings/settings.js'

export type SelfImproveThresholds = {
  skillImprovementTurnBatch: number
  memoryNudgeTurnBatch: number
  skillCreationToolUseThreshold: number
  sessionReviewMinToolUses: number
  sessionReviewMinIntervalHours: number
  autoDreamMinHours: number
  autoDreamMinSessions: number
  skillCreationNudgeEnabled: boolean
  skillImprovementEnabled: boolean
  memoryNudgeEnabled: boolean
  sessionReviewEnabled: boolean
}

const DEFAULTS: SelfImproveThresholds = {
  skillImprovementTurnBatch: 5,
  memoryNudgeTurnBatch: 8,
  skillCreationToolUseThreshold: 15,
  sessionReviewMinToolUses: 15,
  sessionReviewMinIntervalHours: 2,
  autoDreamMinHours: 24,
  autoDreamMinSessions: 5,
  skillCreationNudgeEnabled: true,
  skillImprovementEnabled: true,
  memoryNudgeEnabled: true,
  sessionReviewEnabled: true,
}

type AutoDreamGBPayload = {
  minHours?: number
  minSessions?: number
} | null

function isValidPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function resolve<K extends keyof SelfImproveThresholds>(
  key: K,
  gbValue?: number | undefined,
): SelfImproveThresholds[K] {
  const userVal = getInitialSettings().selfImproveThresholds?.[key]
  if (isValidPositive(userVal)) return userVal as SelfImproveThresholds[K]
  if (isValidPositive(gbValue)) return gbValue as SelfImproveThresholds[K]
  return DEFAULTS[key]
}

function resolveBool<K extends keyof SelfImproveThresholds>(
  key: K,
): SelfImproveThresholds[K] {
  const userVal = getInitialSettings().selfImproveThresholds?.[key]
  if (typeof userVal === 'boolean') return userVal as SelfImproveThresholds[K]
  return DEFAULTS[key]
}

export function getSelfImproveThresholds(): SelfImproveThresholds {
  const gb: AutoDreamGBPayload = null

  return {
    skillImprovementTurnBatch: resolve('skillImprovementTurnBatch'),
    memoryNudgeTurnBatch: resolve('memoryNudgeTurnBatch'),
    skillCreationToolUseThreshold: resolve('skillCreationToolUseThreshold'),
    sessionReviewMinToolUses: resolve('sessionReviewMinToolUses'),
    sessionReviewMinIntervalHours: resolve('sessionReviewMinIntervalHours'),
    autoDreamMinHours: resolve('autoDreamMinHours', gb?.minHours),
    autoDreamMinSessions: resolve('autoDreamMinSessions', gb?.minSessions),
    skillCreationNudgeEnabled: resolveBool('skillCreationNudgeEnabled'),
    skillImprovementEnabled: resolveBool('skillImprovementEnabled'),
    memoryNudgeEnabled: resolveBool('memoryNudgeEnabled'),
    sessionReviewEnabled: resolveBool('sessionReviewEnabled'),
  }
}

// Re-export defaults for testing
export { DEFAULTS as SELF_IMPROVE_DEFAULTS }
