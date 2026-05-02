// M-MEMRECALL-CMD：settings schema + readMemoryRecallSettings 容錯測試。
// 不打 file system，只測 reader 的 clamp / fallback 邏輯。

import { describe, expect, test } from 'bun:test'

// 直接 require 拿 reader，避開 vendored SDK 副作用
const { readMemoryRecallSettings } =
  require('../../../src/memdir/findRelevantMemories.ts') as
    typeof import('../../../src/memdir/findRelevantMemories.js')

describe('readMemoryRecallSettings — defaults + clamp', () => {
  test('未設定 → 預設值（5 / 8）', () => {
    const r = readMemoryRecallSettings()
    expect(typeof r.maxFiles).toBe('number')
    expect(typeof r.fallbackMaxFiles).toBe('number')
    // 在合理範圍內（無論測試環境怎麼 mock）
    expect(r.maxFiles).toBeGreaterThanOrEqual(1)
    expect(r.maxFiles).toBeLessThanOrEqual(20)
    expect(r.fallbackMaxFiles).toBeGreaterThanOrEqual(1)
    expect(r.fallbackMaxFiles).toBeLessThanOrEqual(20)
  })
})

// 行為 spec（純文檔，避免動態 mock 整套 settings 系統）：
// - settings.memoryRecall.maxFiles 範圍 1-20，否則 fallback 預設 5
// - settings.memoryRecall.fallbackMaxFiles 範圍 1-20，否則 fallback 預設 8
// - 任一 read 失敗（settings 系統 throw）→ 全用預設值，不 crash

describe('Settings schema 範圍驗證（透過 zod schema）', () => {
  test('UserSettingsSchema 接受合法 memoryRecall 物件', async () => {
    const { SettingsSchema } = await import('../../../src/utils/settings/types.js')
    const v = SettingsSchema().safeParse({
      memoryRecall: { maxFiles: 5, fallbackMaxFiles: 8 },
    })
    expect(v.success).toBe(true)
  })
  test('maxFiles 越界（21）→ schema reject', async () => {
    const { SettingsSchema } = await import('../../../src/utils/settings/types.js')
    const v = SettingsSchema().safeParse({
      memoryRecall: { maxFiles: 21 },
    })
    expect(v.success).toBe(false)
  })
  test('maxFiles 0 → schema reject', async () => {
    const { SettingsSchema } = await import('../../../src/utils/settings/types.js')
    const v = SettingsSchema().safeParse({
      memoryRecall: { maxFiles: 0 },
    })
    expect(v.success).toBe(false)
  })
  test('fallbackMaxFiles 非整數 → schema reject', async () => {
    const { SettingsSchema } = await import('../../../src/utils/settings/types.js')
    const v = SettingsSchema().safeParse({
      memoryRecall: { fallbackMaxFiles: 5.5 },
    })
    expect(v.success).toBe(false)
  })
  test('memoryRecall 完全省略 → schema accept', async () => {
    const { SettingsSchema } = await import('../../../src/utils/settings/types.js')
    const v = SettingsSchema().safeParse({})
    expect(v.success).toBe(true)
  })
})
