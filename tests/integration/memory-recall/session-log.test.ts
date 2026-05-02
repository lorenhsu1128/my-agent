// M-MEMRECALL-CMD：sessionRecallLog 單元測試。

import { afterEach, describe, expect, test } from 'bun:test'
import {
  _clearAllForTesting,
  clearRecall,
  listRecall,
  recordRecall,
} from '../../../src/memdir/sessionRecallLog.js'

afterEach(() => _clearAllForTesting())

describe('recordRecall / listRecall', () => {
  test('空 session 回 []', () => {
    expect(listRecall('s1')).toEqual([])
  })

  test('record 一筆 → list 拿得到', () => {
    recordRecall('s1', '/tmp/a.md', 'selector')
    const out = listRecall('s1')
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/tmp/a.md')
    expect(out[0].hitCount).toBe(1)
    expect(out[0].source).toBe('selector')
    expect(out[0].ts).toBeGreaterThan(0)
  })

  test('同一 path 多次 record → hitCount 累積，source 取最新', () => {
    recordRecall('s1', '/tmp/a.md', 'selector')
    recordRecall('s1', '/tmp/a.md', 'selector')
    recordRecall('s1', '/tmp/a.md', 'fallback')
    const out = listRecall('s1')
    expect(out).toHaveLength(1)
    expect(out[0].hitCount).toBe(3)
    expect(out[0].source).toBe('fallback')
  })

  test('多 session 隔離', () => {
    recordRecall('s1', '/tmp/a.md', 'selector')
    recordRecall('s2', '/tmp/b.md', 'selector')
    recordRecall('s1', '/tmp/c.md', 'selector')
    expect(listRecall('s1')).toHaveLength(2)
    expect(listRecall('s2')).toHaveLength(1)
    expect(listRecall('s2')[0].path).toBe('/tmp/b.md')
  })

  test('list 依 ts desc（新→舊）排序', async () => {
    recordRecall('s1', '/tmp/a.md', 'selector')
    await new Promise(r => setTimeout(r, 5))
    recordRecall('s1', '/tmp/b.md', 'selector')
    await new Promise(r => setTimeout(r, 5))
    recordRecall('s1', '/tmp/c.md', 'selector')
    const out = listRecall('s1')
    expect(out.map(e => e.path)).toEqual([
      '/tmp/c.md',
      '/tmp/b.md',
      '/tmp/a.md',
    ])
  })

  test('clearRecall 只清指定 session', () => {
    recordRecall('s1', '/tmp/a.md', 'selector')
    recordRecall('s2', '/tmp/b.md', 'selector')
    clearRecall('s1')
    expect(listRecall('s1')).toEqual([])
    expect(listRecall('s2')).toHaveLength(1)
  })

  test('空 sessionId / 空 path 不寫入', () => {
    recordRecall('', '/tmp/a.md', 'selector')
    recordRecall('s1', '', 'selector')
    expect(listRecall('')).toEqual([])
    expect(listRecall('s1')).toEqual([])
  })
})
