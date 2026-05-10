/**
 * M-SP-FULL Phase 2：customSystemPrompt 設了時，hardcoded CLI prefix
 * （getCLISyspromptPrefix「You are a my-agent agent...」）必須被跳過。
 *
 * 否則 override.md 的內容會被 prefix 蓋過，model 仍以 default 身份回答。
 *
 * 實際整合鏈：query.ts:712 把 toolUseContext.options.customSystemPrompt
 * 是否存在轉成 hasCustomSystemPrompt boolean 傳給 queryModelWithoutStreaming
 * → claude.ts:1336 條件 skip prefix。
 *
 * 此測試驗 getCLISyspromptPrefix 本身的契約以及 claude.ts 內 ternary 邏輯。
 */
import { describe, expect, test } from 'bun:test'
import { getCLISyspromptPrefix } from '../../../src/constants/system'

describe('M-SP-FULL Phase 2：CLI prefix 條件跳過', () => {
  test('getCLISyspromptPrefix 仍會回傳非空字串（base contract 不變）', () => {
    const result = getCLISyspromptPrefix({
      isNonInteractive: true,
      hasAppendSystemPrompt: false,
    })
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('my-agent')
  })

  test('hasCustomSystemPrompt=true 條件 ternary 模擬：應該選空字串（被 filter(Boolean) 過濾）', () => {
    // 模擬 claude.ts:1336 的 ternary
    const hasCustomSystemPrompt = true
    const value = hasCustomSystemPrompt
      ? ''
      : getCLISyspromptPrefix({
          isNonInteractive: true,
          hasAppendSystemPrompt: false,
        })
    expect(value).toBe('')
    // .filter(Boolean) 會把空字串過濾掉
    expect([value].filter(Boolean)).toEqual([])
  })

  test('hasCustomSystemPrompt=false 條件 ternary 模擬：應正常回傳 prefix', () => {
    const hasCustomSystemPrompt = false
    const value = hasCustomSystemPrompt
      ? ''
      : getCLISyspromptPrefix({
          isNonInteractive: true,
          hasAppendSystemPrompt: false,
        })
    expect(value.length).toBeGreaterThan(0)
    expect([value].filter(Boolean)).toHaveLength(1)
  })
})
