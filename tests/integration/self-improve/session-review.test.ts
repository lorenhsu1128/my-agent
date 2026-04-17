import { describe, test, expect } from 'bun:test'
import { buildSessionReviewPrompt } from '../../../src/services/selfImprove/sessionReviewPrompt'

describe('sessionReview', () => {
  test('buildSessionReviewPrompt 包含三個 Task', () => {
    const prompt = buildSessionReviewPrompt('/tmp/mem', '/tmp/transcripts')
    expect(prompt).toContain('Task 1')
    expect(prompt).toContain('Create Skills')
    expect(prompt).toContain('Task 2')
    expect(prompt).toContain('Trajectory Summary')
    expect(prompt).toContain('Task 3')
    expect(prompt).toContain('Behavior Notes')
  })

  test('prompt 包含 memory 和 transcript 路徑', () => {
    const prompt = buildSessionReviewPrompt('/home/user/mem', '/home/user/transcripts')
    expect(prompt).toContain('/home/user/mem')
    expect(prompt).toContain('/home/user/transcripts')
  })

  test('prompt 引導使用 SkillManage 工具', () => {
    const prompt = buildSessionReviewPrompt('/tmp/mem', '/tmp/transcripts')
    expect(prompt).toContain('SkillManage')
    expect(prompt).toContain("action='create'")
    expect(prompt).toContain('trajectories/')
    expect(prompt).toContain('user-behavior-notes.md')
  })
})
