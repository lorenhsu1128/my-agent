/**
 * JSONC helper (src/utils/jsoncStore.ts) 單元測試。
 *
 * 覆蓋範圍：
 *   - parseJsonc 容錯與錯誤
 *   - diffPaths 各種 add / modify / delete / 巢狀 / 陣列 case
 *   - writeJsoncPreservingComments 寫回保留註解
 *   - initJsoncFile 首次 seed
 *   - forceRewriteJsoncFile 備份行為
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseJsonc,
  readJsoncFile,
  readJsoncFileSync,
  writeJsoncPreservingComments,
  initJsoncFile,
  forceRewriteJsoncFile,
  diffPaths,
} from '../../../src/utils/jsoncStore'

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `jsoncStore-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Windows 檔案系統鎖定時忽略
  }
})

describe('parseJsonc', () => {
  test('解析純 JSON', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 })
  })

  test('解析含 // 行註解的 JSONC', () => {
    const text = `{
  // 這是註解
  "a": 1, // 行尾註解
  "b": "hello"
}`
    expect(parseJsonc(text)).toEqual({ a: 1, b: 'hello' })
  })

  test('解析含 /* */ 區塊註解', () => {
    const text = `{
  /* 這是區塊
     多行註解 */
  "a": 1
}`
    expect(parseJsonc(text)).toEqual({ a: 1 })
  })

  test('允許尾部逗號', () => {
    expect(parseJsonc('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 })
    expect(parseJsonc('[1, 2, 3,]')).toEqual([1, 2, 3])
  })

  test('空字串回 undefined（allowEmptyContent）', () => {
    expect(parseJsonc('')).toBeUndefined()
  })

  test('語法錯誤 throw', () => {
    expect(() => parseJsonc('{"a": }')).toThrow(/JSONC 解析失敗/)
  })
})

describe('diffPaths', () => {
  test('相同物件回空陣列', () => {
    expect(diffPaths({ a: 1 }, { a: 1 })).toEqual([])
  })

  test('改變單一欄位', () => {
    const edits = diffPaths({ a: 1 }, { a: 2 })
    expect(edits).toEqual([{ path: ['a'], value: 2 }])
  })

  test('新增欄位', () => {
    const edits = diffPaths({ a: 1 }, { a: 1, b: 'new' })
    expect(edits).toEqual([{ path: ['b'], value: 'new' }])
  })

  test('刪除欄位（undefined 代表 delete）', () => {
    const edits = diffPaths({ a: 1, b: 2 }, { a: 1 })
    expect(edits).toEqual([{ path: ['b'], value: undefined }])
  })

  test('巢狀物件只回最細路徑', () => {
    const edits = diffPaths(
      { outer: { a: 1, b: 2 } },
      { outer: { a: 1, b: 99 } },
    )
    expect(edits).toEqual([{ path: ['outer', 'b'], value: 99 }])
  })

  test('巢狀物件多個欄位變更', () => {
    const edits = diffPaths(
      { outer: { a: 1, b: 2, c: 3 } },
      { outer: { a: 10, b: 20, c: 3 } },
    )
    expect(edits).toHaveLength(2)
    expect(edits).toContainEqual({ path: ['outer', 'a'], value: 10 })
    expect(edits).toContainEqual({ path: ['outer', 'b'], value: 20 })
  })

  test('陣列整體替換（不做 per-element diff）', () => {
    const edits = diffPaths({ arr: [1, 2] }, { arr: [1, 2, 3] })
    expect(edits).toEqual([{ path: ['arr'], value: [1, 2, 3] }])
  })

  test('型別改變 → 整個 replace', () => {
    const edits = diffPaths({ a: { x: 1 } }, { a: 'string' })
    expect(edits).toEqual([{ path: ['a'], value: 'string' }])
  })

  test('null → plain object 視為 replace', () => {
    const edits = diffPaths({ a: null }, { a: { x: 1 } })
    expect(edits).toEqual([{ path: ['a'], value: { x: 1 } }])
  })
})

describe('writeJsoncPreservingComments', () => {
  test('保留行註解寫回單一欄位', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 使用者 ID（勿手改）
  "userID": "abc",
  // 是否開詳細 log
  "verbose": false
}`
    writeFileSync(path, original, 'utf-8')
    await writeJsoncPreservingComments(path, original, {
      userID: 'abc',
      verbose: true,
    })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('// 使用者 ID（勿手改）')
    expect(after).toContain('// 是否開詳細 log')
    expect(after).toContain('"verbose": true')
    expect(after).toContain('"userID": "abc"')
  })

  test('保留區塊註解', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  /* ===== 功能開關 ===== */
  "enabled": false
}`
    writeFileSync(path, original, 'utf-8')
    await writeJsoncPreservingComments(path, original, { enabled: true })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('/* ===== 功能開關 ===== */')
    expect(after).toContain('"enabled": true')
  })

  test('巢狀欄位寫回不洗掉父/兄弟註解', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 專案層資料
  "projects": {
    // my-agent 專案
    "my-agent": {
      "lastCost": 0,
      "lastSession": "abc"
    }
  }
}`
    writeFileSync(path, original, 'utf-8')
    await writeJsoncPreservingComments(path, original, {
      projects: {
        'my-agent': {
          lastCost: 42.5,
          lastSession: 'abc',
        },
      },
    })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('// 專案層資料')
    expect(after).toContain('// my-agent 專案')
    expect(after).toContain('"lastCost": 42.5')
  })

  test('無變更時不動檔案', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 保持
  "a": 1
}`
    writeFileSync(path, original, 'utf-8')
    const result = await writeJsoncPreservingComments(path, original, { a: 1 })
    expect(result.changed).toBe(false)
    const after = readFileSync(path, 'utf-8')
    expect(after).toBe(original)
  })

  test('刪除欄位後註解仍保留在檔案（但該欄位消失）', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 欄位 A
  "a": 1,
  // 欄位 B
  "b": 2
}`
    writeFileSync(path, original, 'utf-8')
    await writeJsoncPreservingComments(path, original, { a: 1 })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('"a": 1')
    expect(after).not.toContain('"b": 2')
    // 欄位 A 的註解必須仍在
    expect(after).toContain('// 欄位 A')
  })

  test('新增欄位（無註解，位置在父物件尾端）', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 原有
  "a": 1
}`
    writeFileSync(path, original, 'utf-8')
    await writeJsoncPreservingComments(path, original, { a: 1, b: 2 })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('// 原有')
    expect(after).toContain('"a": 1')
    expect(after).toContain('"b": 2')
  })

  test('陣列元素內欄位變更', async () => {
    const path = join(testDir, 'cfg.json')
    const original = `{
  // 任務清單
  "tasks": [
    { "id": "t1", "lastFiredAt": 0 },
    { "id": "t2", "lastFiredAt": 0 }
  ]
}`
    writeFileSync(path, original, 'utf-8')
    // 陣列整體替換（diffPaths 對陣列不做 per-element diff）
    await writeJsoncPreservingComments(path, original, {
      tasks: [
        { id: 't1', lastFiredAt: 1000 },
        { id: 't2', lastFiredAt: 0 },
      ],
    })
    const after = readFileSync(path, 'utf-8')
    expect(after).toContain('// 任務清單')
    expect(after).toContain('"lastFiredAt": 1000')
  })
})

describe('readJsoncFile / readJsoncFileSync', () => {
  test('檔案不存在回 null', async () => {
    const path = join(testDir, 'missing.json')
    expect(await readJsoncFile(path)).toBeNull()
    expect(readJsoncFileSync(path)).toBeNull()
  })

  test('讀 JSONC 回 { text, parsed }', async () => {
    const path = join(testDir, 'ok.json')
    writeFileSync(
      path,
      `{
  // comment
  "x": 42
}`,
      'utf-8',
    )
    const result = await readJsoncFile<{ x: number }>(path)
    expect(result).not.toBeNull()
    expect(result!.parsed).toEqual({ x: 42 })
    expect(result!.text).toContain('// comment')
  })

  test('BOM 被剝除', async () => {
    const path = join(testDir, 'bom.json')
    writeFileSync(path, '﻿{"x": 1}', 'utf-8')
    const result = await readJsoncFile<{ x: number }>(path)
    expect(result!.parsed).toEqual({ x: 1 })
  })
})

describe('initJsoncFile', () => {
  test('首次落盤', async () => {
    const path = join(testDir, 'seed.json')
    const tpl = `{
  // seeded
  "seeded": true
}`
    const result = await initJsoncFile(path, tpl)
    expect(result.created).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(tpl)
  })

  test('已存在不動', async () => {
    const path = join(testDir, 'exists.json')
    writeFileSync(path, '{"user-edit": true}', 'utf-8')
    const result = await initJsoncFile(path, '{"seeded": "default"}')
    expect(result.created).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('{"user-edit": true}')
  })

  test('建立父目錄', async () => {
    const path = join(testDir, 'sub', 'dir', 'cfg.json')
    await initJsoncFile(path, '{}')
    expect(existsSync(path)).toBe(true)
  })
})

describe('forceRewriteJsoncFile', () => {
  test('存在的檔案會備份', async () => {
    const path = join(testDir, 'f.json')
    writeFileSync(path, 'OLD', 'utf-8')
    const { backupPath } = await forceRewriteJsoncFile(path, 'NEW')
    expect(backupPath).not.toBeNull()
    expect(existsSync(backupPath!)).toBe(true)
    expect(readFileSync(backupPath!, 'utf-8')).toBe('OLD')
    expect(readFileSync(path, 'utf-8')).toBe('NEW')
  })

  test('不存在的檔案直接建立（無備份）', async () => {
    const path = join(testDir, 'new.json')
    const { backupPath } = await forceRewriteJsoncFile(path, 'NEW')
    expect(backupPath).toBeNull()
    expect(readFileSync(path, 'utf-8')).toBe('NEW')
  })
})
