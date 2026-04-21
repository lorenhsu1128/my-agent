/**
 * M-TOOLS-PICKER — getTools() disabledTools filter behaviour.
 *
 * 驗證：
 *   - 沒傳 disabledTools → 行為與舊版一致
 *   - 傳了名字 → 對應 tool 從回傳清單消失
 *   - UNTOGGLEABLE_TOOLS 的 tool 就算被傳進 disabledTools 也必保留
 *   - 空 Set 不影響結果
 */
import { describe, expect, test } from 'bun:test'
import { UNTOGGLEABLE_TOOLS } from '../../../src/constants/untoggleableTools'
import { getEmptyToolPermissionContext } from '../../../src/Tool'
import { getTools } from '../../../src/tools'

// permission context 基本款 — 沒有 deny rule
const permCtx = {
  ...getEmptyToolPermissionContext(),
  mode: 'default' as const,
}

describe('getTools + disabledTools filter', () => {
  test('no opts → returns baseline tool set', () => {
    const all = getTools(permCtx)
    expect(all.length).toBeGreaterThan(10)
    // baseline 必含 WebBrowser / Bash（至少這兩個）
    expect(all.some(t => t.name === 'Bash')).toBe(true)
    expect(all.some(t => t.name === 'WebBrowser')).toBe(true)
  })

  test('empty Set → identical to no opts', () => {
    const baseline = getTools(permCtx)
    const filtered = getTools(permCtx, { disabledTools: new Set() })
    expect(filtered.map(t => t.name).sort()).toEqual(
      baseline.map(t => t.name).sort(),
    )
  })

  test('disable a non-core tool → tool removed', () => {
    const filtered = getTools(permCtx, {
      disabledTools: new Set(['WebBrowser']),
    })
    expect(filtered.some(t => t.name === 'WebBrowser')).toBe(false)
    // 其他還在
    expect(filtered.some(t => t.name === 'Bash')).toBe(true)
  })

  test('disable multiple tools → all removed', () => {
    const toDisable = new Set(['WebBrowser', 'WebCrawl'])
    const filtered = getTools(permCtx, { disabledTools: toDisable })
    for (const name of toDisable) {
      expect(filtered.some(t => t.name === name)).toBe(false)
    }
  })

  test('core tools never get filtered even if listed', () => {
    // 嘗試把所有 UNTOGGLEABLE_TOOLS 都關掉 — filter 必須忽略
    const filtered = getTools(permCtx, {
      disabledTools: new Set(UNTOGGLEABLE_TOOLS),
    })
    for (const core of UNTOGGLEABLE_TOOLS) {
      expect(filtered.some(t => t.name === core)).toBe(true)
    }
  })

  test('mixed core + non-core → non-core removed, core stays', () => {
    const filtered = getTools(permCtx, {
      disabledTools: new Set(['Read', 'Bash', 'WebBrowser', 'WebCrawl']),
    })
    expect(filtered.some(t => t.name === 'Read')).toBe(true) // core, locked
    expect(filtered.some(t => t.name === 'Bash')).toBe(true) // core, locked
    expect(filtered.some(t => t.name === 'WebBrowser')).toBe(false)
    expect(filtered.some(t => t.name === 'WebCrawl')).toBe(false)
  })

  test('unknown tool name in disabledTools → no-op, no error', () => {
    const baseline = getTools(permCtx)
    const filtered = getTools(permCtx, {
      disabledTools: new Set(['NonExistentTool', 'AnotherFakeTool']),
    })
    expect(filtered.map(t => t.name).sort()).toEqual(
      baseline.map(t => t.name).sort(),
    )
  })
})

describe('UNTOGGLEABLE_TOOLS set', () => {
  test('contains the minimum viable core set', () => {
    // 如果未來 rename 任何 core tool，這個測試會抓到 drift
    expect(UNTOGGLEABLE_TOOLS.has('Read')).toBe(true)
    expect(UNTOGGLEABLE_TOOLS.has('Write')).toBe(true)
    expect(UNTOGGLEABLE_TOOLS.has('Edit')).toBe(true)
    expect(UNTOGGLEABLE_TOOLS.has('Bash')).toBe(true)
    expect(UNTOGGLEABLE_TOOLS.has('Glob')).toBe(true)
    expect(UNTOGGLEABLE_TOOLS.has('Grep')).toBe(true)
  })

  test('all core names resolve to registered tools', () => {
    const all = getTools(permCtx)
    const allNames = new Set(all.map(t => t.name))
    for (const core of UNTOGGLEABLE_TOOLS) {
      // 若此失敗 → UNTOGGLEABLE 裡有 rename / 不存在的 tool
      expect(allNames.has(core)).toBe(true)
    }
  })
})
