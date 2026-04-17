import { describe, test, expect } from 'bun:test'
import { buildSessionReviewPrompt } from '../../../src/services/selfImprove/sessionReviewPrompt'

describe('sessionReview', () => {
  test('buildSessionReviewPrompt 包含三個 Task', () => {
    const prompt = buildSessionReviewPrompt('/tmp/mem', '/tmp/transcripts')
    expect(prompt).toContain('Task 1')
    expect(prompt).toContain('Skill Drafts')
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

  test('prompt 包含 skill-drafts 目錄指示', () => {
    const prompt = buildSessionReviewPrompt('/tmp/mem', '/tmp/transcripts')
    expect(prompt).toContain('skill-drafts/')
    expect(prompt).toContain('trajectories/')
    expect(prompt).toContain('user-behavior-notes.md')
  })
})
