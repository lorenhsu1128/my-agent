/**
 * 階段 3 — llamacpp adapter tool-usage nudge 行為。
 *
 * 目的：在 request 含 tools 定義時，翻譯後的 OpenAI system message 尾端應包含
 * TOOL_USAGE_POLICY_NUDGE；純對話（無 tools）不加，避免污染。
 */
import { describe, expect, test } from 'bun:test'
import {
  TOOL_USAGE_POLICY_NUDGE,
  translateRequestToOpenAI,
} from '../../../src/services/api/llamacpp-fetch-adapter'

describe('translateRequestToOpenAI — tool-usage nudge', () => {
  test('有 tools 定義 → system prompt 尾端追加 nudge', () => {
    const result = translateRequestToOpenAI(
      {
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'Bash',
            description: 'run shell',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
      'test-model',
    )
    const sys = result.messages.find(m => m.role === 'system')
    expect(sys).toBeDefined()
    expect(sys!.content).toContain('You are a helpful assistant.')
    expect(sys!.content).toContain(TOOL_USAGE_POLICY_NUDGE)
    // nudge 在尾端
    expect(sys!.content!.endsWith(TOOL_USAGE_POLICY_NUDGE)).toBe(true)
  })

  test('沒 tools → 不追加 nudge（純對話不污染）', () => {
    const result = translateRequestToOpenAI(
      {
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hi' }],
      },
      'test-model',
    )
    const sys = result.messages.find(m => m.role === 'system')
    expect(sys!.content).toBe('You are a helpful assistant.')
    expect(sys!.content).not.toContain(TOOL_USAGE_POLICY_NUDGE)
  })

  test('tools 空陣列 → 不追加 nudge', () => {
    const result = translateRequestToOpenAI(
      {
        system: 'Sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      },
      'test-model',
    )
    const sys = result.messages.find(m => m.role === 'system')
    expect(sys!.content).toBe('Sys')
  })

  test('沒 system prompt + 有 tools → 建立 system msg 只含 nudge', () => {
    const result = translateRequestToOpenAI(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'X',
            description: '',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
      'test-model',
    )
    const sys = result.messages.find(m => m.role === 'system')
    expect(sys).toBeDefined()
    expect(sys!.content).toBe(TOOL_USAGE_POLICY_NUDGE)
  })

  test('沒 system + 沒 tools → 沒有 system message', () => {
    const result = translateRequestToOpenAI(
      {
        messages: [{ role: 'user', content: 'hi' }],
      },
      'test-model',
    )
    const sys = result.messages.find(m => m.role === 'system')
    expect(sys).toBeUndefined()
  })

  test('nudge 內容包含關鍵指令詞', () => {
    expect(TOOL_USAGE_POLICY_NUDGE).toContain('Tool usage policy')
    expect(TOOL_USAGE_POLICY_NUDGE).toContain('MUST emit a tool_use block')
  })
})
