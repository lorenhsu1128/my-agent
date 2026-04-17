import { describe, test, expect } from 'bun:test'
import { parseMemoryNudgeResponse } from '../../../src/utils/hooks/memoryNudge'

describe('memoryNudge', () => {
  test('parseResponse 正確解析 <memories> 標籤', () => {
    const result = parseMemoryNudgeResponse(
      '<memories>[{"content":"always use dark mode","type":"feedback","reason":"user correction"}]</memories>',
    )
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('always use dark mode')
    expect(result[0].type).toBe('feedback')
    expect(result[0].reason).toBe('user correction')
  })

  test('parseResponse 多筆結果', () => {
    const result = parseMemoryNudgeResponse(
      '<memories>[{"content":"prefer dark mode","type":"user","reason":"said so"},{"content":"no emojis","type":"feedback","reason":"asked to stop"}]</memories>',
    )
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('prefer dark mode')
    expect(result[1].content).toBe('no emojis')
  })

  test('parseResponse 空陣列返回空', () => {
    const result = parseMemoryNudgeResponse('<memories>[]</memories>')
    expect(result).toHaveLength(0)
  })

  test('parseResponse 無標籤返回空', () => {
    const result = parseMemoryNudgeResponse('No memories found.')
    expect(result).toHaveLength(0)
  })

  test('parseResponse 無效 JSON 返回空', () => {
    const result = parseMemoryNudgeResponse('<memories>not valid json</memories>')
    expect(result).toHaveLength(0)
  })
})
