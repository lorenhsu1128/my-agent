import { describe, test, expect } from 'bun:test'
import { buildConsolidationPrompt } from '../../../src/services/autoDream/consolidationPrompt'

describe('EnhancedDream prompt', () => {
  test('包含 Phase 5 Skill Audit', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 5')
    expect(prompt).toContain('Skill Audit')
    expect(prompt).toContain('.my-agent/skills/')
  })

  test('包含 Phase 6 Behavior Notes', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 6')
    expect(prompt).toContain('Behavior Notes')
    expect(prompt).toContain('user-behavior-notes.md')
  })

  test('保留原有 Phase 1-4', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', '')
    expect(prompt).toContain('Phase 1')
    expect(prompt).toContain('Phase 2')
    expect(prompt).toContain('Phase 3')
    expect(prompt).toContain('Phase 4')
  })

  test('extra 參數仍正確附加', () => {
    const prompt = buildConsolidationPrompt('/tmp/mem', '/tmp/transcripts', 'extra context here')
    expect(prompt).toContain('extra context here')
    expect(prompt).toContain('## Additional context')
  })
})
