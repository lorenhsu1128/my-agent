/**
 * 階段 2 — filterDuplicateMemoryAttachments 的 dedup 放鬆行為。
 *
 * 驗證 2026-04-24 變更：
 *   - 不再因 readFileState 含 path 就 drop memory（舊行為會封鎖已 Read 過的 memory）
 *   - 仍會更新 readFileState（讓後續 Read tool 知 timestamp）
 *   - 同 attachment 內重複 path 會去重
 *   - 空 / 非 memory attachments 照傳
 */
import { describe, expect, test } from 'bun:test'
import { filterDuplicateMemoryAttachments } from '../../../src/utils/attachments'

type FakeFileState = Map<
  string,
  { content: string; timestamp: number; offset: undefined; limit: undefined }
>

function mkMemAttach(paths: string[]) {
  return {
    type: 'relevant_memories' as const,
    memories: paths.map(p => ({
      path: p,
      content: `content of ${p}`,
      mtimeMs: 1000,
      limit: undefined,
    })),
  }
}

describe('filterDuplicateMemoryAttachments — relaxed dedup', () => {
  test('readFileState 含 path 仍注入（不再封鎖 LLM Read 過的 memory）', () => {
    const state: FakeFileState = new Map()
    state.set('/mem/weather.md', {
      content: 'old',
      timestamp: 500,
      offset: undefined,
      limit: undefined,
    })
    const result = filterDuplicateMemoryAttachments(
      [mkMemAttach(['/mem/weather.md'])],
      state as never,
    )
    expect(result.length).toBe(1)
    if (result[0]!.type === 'relevant_memories') {
      expect(result[0]!.memories.length).toBe(1)
      expect(result[0]!.memories[0]!.path).toBe('/mem/weather.md')
    }
    // readFileState 被更新為新 content/timestamp
    expect(state.get('/mem/weather.md')!.content).toBe('content of /mem/weather.md')
    expect(state.get('/mem/weather.md')!.timestamp).toBe(1000)
  })

  test('同 attachment 內重複 path 去重', () => {
    const state: FakeFileState = new Map()
    const attach = mkMemAttach(['/mem/a.md', '/mem/b.md', '/mem/a.md'])
    const result = filterDuplicateMemoryAttachments([attach], state as never)
    expect(result.length).toBe(1)
    if (result[0]!.type === 'relevant_memories') {
      const paths = result[0]!.memories.map(m => m.path)
      expect(paths).toEqual(['/mem/a.md', '/mem/b.md'])
    }
  })

  test('multiple memory attachments 各自處理', () => {
    const state: FakeFileState = new Map()
    const result = filterDuplicateMemoryAttachments(
      [mkMemAttach(['/mem/a.md']), mkMemAttach(['/mem/b.md'])],
      state as never,
    )
    expect(result.length).toBe(2)
  })

  test('空 attachment 陣列 → 空結果', () => {
    const state: FakeFileState = new Map()
    expect(filterDuplicateMemoryAttachments([], state as never)).toEqual([])
  })

  test('非 relevant_memories attachment 照傳', () => {
    const state: FakeFileState = new Map()
    const other = { type: 'some_other_type', data: 'x' } as never
    const result = filterDuplicateMemoryAttachments([other], state as never)
    expect(result).toEqual([other])
  })

  test('memory 全數重複後仍有 non-empty 結果（不會 drop 整個 attachment）', () => {
    const state: FakeFileState = new Map()
    state.set('/mem/a.md', {
      content: 'old',
      timestamp: 500,
      offset: undefined,
      limit: undefined,
    })
    // 即使 path 已在 state 裡，仍然注入
    const result = filterDuplicateMemoryAttachments(
      [mkMemAttach(['/mem/a.md'])],
      state as never,
    )
    expect(result.length).toBe(1)
  })
})
