/**
 * M-WEB-SLASH-D2：categorize() 純函式分類測試。
 */
import { describe, expect, test } from 'bun:test'
import { categorize } from '../../../web/src/components/slash/commandCategory'

describe('categorize', () => {
  test('config 類', () => {
    expect(categorize('config').category).toBe('config')
    expect(categorize('model').category).toBe('config')
    expect(categorize('permissions').category).toBe('config')
    expect(categorize('output-style').category).toBe('config')
    expect(categorize('hooks').category).toBe('config')
    expect(categorize('plugin').category).toBe('config')
    expect(categorize('theme').category).toBe('config')
  })

  test('memory 類（含 prefix memory-）', () => {
    expect(categorize('memory-debug').category).toBe('memory')
    expect(categorize('dream').category).toBe('memory')
    expect(categorize('recall').category).toBe('memory')
    expect(categorize('memory-search').category).toBe('memory')
    expect(categorize('memory-export').category).toBe('memory')
  })

  test('session 類', () => {
    expect(categorize('sessions').category).toBe('session')
    expect(categorize('resume').category).toBe('session')
    expect(categorize('compact').category).toBe('session')
    expect(categorize('cost').category).toBe('session')
  })

  test('project 類', () => {
    expect(categorize('init').category).toBe('project')
    expect(categorize('agents').category).toBe('project')
    expect(categorize('skills').category).toBe('project')
    expect(categorize('mcp').category).toBe('project')
    expect(categorize('version').category).toBe('project')
  })

  test('agent-tool 類', () => {
    expect(categorize('plan').category).toBe('agent-tool')
    expect(categorize('tasks').category).toBe('agent-tool')
    expect(categorize('think').category).toBe('agent-tool')
    expect(categorize('long-context').category).toBe('agent-tool')
  })

  test('未知命令落 misc', () => {
    expect(categorize('totally-new-command').category).toBe('misc')
    expect(categorize('xyz123').category).toBe('misc')
  })

  test('每個分類都有 label + hint', () => {
    const samples = ['config', 'memory-debug', 'sessions', 'init', 'plan', 'unknown']
    for (const s of samples) {
      const r = categorize(s)
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.hint.length).toBeGreaterThan(0)
    }
  })

  test('memory 規則先於 session（避免 memory-search 被搶）', () => {
    expect(categorize('memory-search').category).toBe('memory')
  })
})
