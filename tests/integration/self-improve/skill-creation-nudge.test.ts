import { describe, test, expect } from 'bun:test'
import {
  parseSkillCandidateResponse,
  countRecentToolUses,
  formatToolSequence,
} from '../../../src/utils/hooks/skillCreationNudge'
import type { Message } from '../../../src/types/message'

function createMockAssistantMessage(toolUses: { name: string; input: Record<string, unknown> }[]): Message {
  return {
    type: 'assistant' as const,
    uuid: `mock-${Math.random().toString(36).slice(2)}`,
    message: {
      id: 'msg-mock',
      type: 'message',
      role: 'assistant',
      content: toolUses.map(tu => ({
        type: 'tool_use' as const,
        id: `tu-${Math.random().toString(36).slice(2)}`,
        name: tu.name,
        input: tu.input,
      })),
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    costUSD: 0,
  } as unknown as Message
}

describe('skillCreationNudge', () => {
  test('parseResponse 正確解析 <candidate> 標籤 — isCandidate true', () => {
    const result = parseSkillCandidateResponse(
      '<candidate>{"isCandidate":true,"name":"deploy-check","description":"Pre-deploy verification","steps":["typecheck","test","build"]}</candidate>',
    )
    expect(result.isCandidate).toBe(true)
    expect(result.name).toBe('deploy-check')
    expect(result.description).toBe('Pre-deploy verification')
    expect(result.steps).toHaveLength(3)
  })

  test('parseResponse 非候選返回 isCandidate=false', () => {
    const result = parseSkillCandidateResponse(
      '<candidate>{"isCandidate":false}</candidate>',
    )
    expect(result.isCandidate).toBe(false)
  })

  test('parseResponse 無標籤返回 isCandidate=false', () => {
    const result = parseSkillCandidateResponse('Nothing worth saving.')
    expect(result.isCandidate).toBe(false)
  })

  test('countRecentToolUses 正確計數', () => {
    const messages: Message[] = [
      createMockAssistantMessage([
        { name: 'Read', input: { file_path: '/tmp/a.ts' } },
        { name: 'Edit', input: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' } },
      ]),
      createMockAssistantMessage([
        { name: 'Bash', input: { command: 'bun test' } },
      ]),
    ]
    const count = countRecentToolUses(messages, 0)
    expect(count).toBe(3)
  })

  test('formatToolSequence 提取工具名和輸入鍵名', () => {
    const messages: Message[] = [
      createMockAssistantMessage([
        { name: 'Read', input: { file_path: '/tmp/a.ts' } },
        { name: 'Bash', input: { command: 'bun test', timeout: 30000 } },
      ]),
    ]
    const formatted = formatToolSequence(messages)
    expect(formatted).toContain('tool_use: Read(file_path)')
    expect(formatted).toContain('tool_use: Bash(command, timeout)')
  })
})
