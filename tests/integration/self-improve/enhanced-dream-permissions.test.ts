import { describe, test, expect } from 'bun:test'
import { buildConsolidationPrompt } from '../../../src/services/autoDream/consolidationPrompt'

describe('Enhanced AutoDream prompt (Phase 7-9)', () => {
  test('包含 Phase 7 Skill Draft Review', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 7')
    expect(prompt).toContain('Skill Draft Review')
    expect(prompt).toContain('skill-drafts/')
    expect(prompt).toContain('observed-sessions')
    expect(prompt).toContain('3+')
  })

  test('包含 Phase 8 Safety Checklist', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 8')
    expect(prompt).toContain('Safety Checklist')
    expect(prompt).toContain('rm -rf')
    expect(prompt).toContain('prompt injection')
    expect(prompt).toContain('< 10KB')
    expect(prompt).toContain('< 50')
  })

  test('包含 Phase 9 Trajectory Pruning', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 9')
    expect(prompt).toContain('Trajectory Pruning')
    expect(prompt).toContain('30 days')
  })

  test('保留原有 Phase 1-6', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    for (let i = 1; i <= 6; i++) {
      expect(prompt).toContain(`Phase ${i}`)
    }
  })
})
