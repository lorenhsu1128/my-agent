import { describe, test, expect } from 'bun:test'
import { buildConsolidationPrompt } from '../../../src/services/autoDream/consolidationPrompt'

describe('Enhanced AutoDream prompt (Phase 7-8)', () => {
  test('包含 Phase 7 Skill Draft Cleanup', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 7')
    expect(prompt).toContain('Skill Draft Cleanup')
    expect(prompt).toContain('skill-drafts/')
    expect(prompt).toContain('SkillManageTool')
  })

  test('包含 Phase 8 Trajectory Pruning', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 8')
    expect(prompt).toContain('Trajectory Pruning')
    expect(prompt).toContain('30 days')
  })

  test('不再包含 Safety Checklist（已移至 SkillManageTool 程式碼層級）', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).not.toContain('Safety Checklist')
  })

  test('保留原有 Phase 1-6', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    for (let i = 1; i <= 6; i++) {
      expect(prompt).toContain(`Phase ${i}`)
    }
  })
})
