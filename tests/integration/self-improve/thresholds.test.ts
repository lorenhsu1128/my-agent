import { describe, test, expect } from 'bun:test'
import {
  getSelfImproveThresholds,
  SELF_IMPROVE_DEFAULTS,
} from '../../../src/services/selfImprove/thresholds'

describe('selfImprove thresholds', () => {
  test('無設定時回傳全部 7 個預設值', () => {
    const t = getSelfImproveThresholds()
    expect(t.skillImprovementTurnBatch).toBe(SELF_IMPROVE_DEFAULTS.skillImprovementTurnBatch)
    expect(t.memoryNudgeTurnBatch).toBe(SELF_IMPROVE_DEFAULTS.memoryNudgeTurnBatch)
    expect(t.skillCreationToolUseThreshold).toBe(SELF_IMPROVE_DEFAULTS.skillCreationToolUseThreshold)
    expect(t.sessionReviewMinToolUses).toBe(SELF_IMPROVE_DEFAULTS.sessionReviewMinToolUses)
    expect(t.sessionReviewMinIntervalHours).toBe(SELF_IMPROVE_DEFAULTS.sessionReviewMinIntervalHours)
    expect(t.autoDreamMinHours).toBe(SELF_IMPROVE_DEFAULTS.autoDreamMinHours)
    expect(t.autoDreamMinSessions).toBe(SELF_IMPROVE_DEFAULTS.autoDreamMinSessions)
  })

  test('預設值為已知常數', () => {
    expect(SELF_IMPROVE_DEFAULTS.skillImprovementTurnBatch).toBe(5)
    expect(SELF_IMPROVE_DEFAULTS.memoryNudgeTurnBatch).toBe(8)
    expect(SELF_IMPROVE_DEFAULTS.skillCreationToolUseThreshold).toBe(15)
    expect(SELF_IMPROVE_DEFAULTS.sessionReviewMinToolUses).toBe(15)
    expect(SELF_IMPROVE_DEFAULTS.sessionReviewMinIntervalHours).toBe(2)
    expect(SELF_IMPROVE_DEFAULTS.autoDreamMinHours).toBe(24)
    expect(SELF_IMPROVE_DEFAULTS.autoDreamMinSessions).toBe(5)
  })

  test('回傳值都是正數', () => {
    const t = getSelfImproveThresholds()
    for (const [key, value] of Object.entries(t)) {
      expect(value).toBeGreaterThan(0)
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  test('sessionReviewMinIntervalHours 預設值支援與小數比較', () => {
    const t = getSelfImproveThresholds()
    // 預設是 2，但設計上支援小數（如 0.5 = 30 分鐘）
    expect(t.sessionReviewMinIntervalHours).toBe(2)
    expect(typeof t.sessionReviewMinIntervalHours).toBe('number')
  })
})
