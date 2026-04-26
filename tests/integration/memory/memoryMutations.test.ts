// M-MEMTUI Phase 2：memoryMutations.ts 單元測試。
// 用 mock.module 把 getAutoMemPath 換成 tmpdir，不污染真實 memdir。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpMemDir: string
let tmpCwd: string

beforeEach(() => {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  tmpMemDir = join(tmpdir(), `memtui-memdir-${stamp}`)
  tmpCwd = join(tmpdir(), `memtui-cwd-${stamp}`)
  mkdirSync(tmpMemDir, { recursive: true })
  mkdirSync(tmpCwd, { recursive: true })
  mkdirSync(join(tmpCwd, '.my-agent'), { recursive: true })
  // .trash 由 moveToTrash 自動建；確保 cwd 存在即可
})

afterEach(() => {
  try {
    rmSync(tmpMemDir, { recursive: true, force: true })
  } catch {}
  try {
    rmSync(tmpCwd, { recursive: true, force: true })
  } catch {}
})

// 先 import 原始模組以保留其他 export，再用 mock.module 覆蓋我們關心的 3 個。
const realPaths = await import('../../../src/memdir/paths.js')
mock.module('../../../src/memdir/paths.js', () => ({
  ...realPaths,
  getAutoMemPath: () => tmpMemDir,
  getMemoryBaseDir: () => tmpMemDir,
  isAutoMemoryEnabled: () => true,
}))

// 動態載入 — 等 mock 註冊完
async function loadMutations(): Promise<
  typeof import('../../../src/commands/memory/memoryMutations.js')
> {
  return await import('../../../src/commands/memory/memoryMutations.js')
}

describe('createAutoMemory', () => {
  test('正常建立 → 檔案 + MEMORY.md 索引行', async () => {
    const m = await loadMutations()
    const r = await m.createAutoMemory({
      filename: 'test_create.md',
      name: 'Test',
      description: 'desc',
      type: 'feedback',
      body: 'hello body',
    })
    expect(r.ok).toBe(true)
    const filePath = join(tmpMemDir, 'test_create.md')
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('name: Test')
    expect(content).toContain('description: desc')
    expect(content).toContain('type: feedback')
    expect(content).toContain('hello body')
    const indexPath = join(tmpMemDir, 'MEMORY.md')
    expect(existsSync(indexPath)).toBe(true)
    expect(readFileSync(indexPath, 'utf-8')).toContain(
      '- [Test](test_create.md) — desc',
    )
  })

  test('filename 不合法 → 拒絕', async () => {
    const m = await loadMutations()
    const r = await m.createAutoMemory({
      filename: 'no-ext',
      name: 'x',
      description: 'x',
      type: 'feedback',
      body: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('.md')
  })

  test('已存在 → 拒絕', async () => {
    const m = await loadMutations()
    writeFileSync(join(tmpMemDir, 'dup.md'), '...')
    const r = await m.createAutoMemory({
      filename: 'dup.md',
      name: 'x',
      description: 'x',
      type: 'feedback',
      body: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('已存在')
  })
})

describe('updateAutoMemory', () => {
  test('frontmatter + body 都換、索引更新', async () => {
    const m = await loadMutations()
    await m.createAutoMemory({
      filename: 'upd.md',
      name: 'Old',
      description: 'old desc',
      type: 'feedback',
      body: 'old body',
    })
    const r = await m.updateAutoMemory({
      filename: 'upd.md',
      name: 'New',
      description: 'new desc',
      type: 'project',
      body: 'new body',
    })
    expect(r.ok).toBe(true)
    const content = readFileSync(join(tmpMemDir, 'upd.md'), 'utf-8')
    expect(content).toContain('name: New')
    expect(content).toContain('type: project')
    expect(content).toContain('new body')
    expect(readFileSync(join(tmpMemDir, 'MEMORY.md'), 'utf-8')).toContain(
      '- [New](upd.md) — new desc',
    )
  })

  test('檔案不存在 → 拒絕', async () => {
    const m = await loadMutations()
    const r = await m.updateAutoMemory({
      filename: 'ghost.md',
      name: 'x',
      description: 'x',
      type: 'feedback',
      body: 'x',
    })
    expect(r.ok).toBe(false)
  })
})

describe('renameAutoMemory', () => {
  test('atomic rename + MEMORY.md 索引同步（舊行刪、新行加）', async () => {
    const m = await loadMutations()
    await m.createAutoMemory({
      filename: 'before.md',
      name: 'Stable',
      description: 'stable desc',
      type: 'feedback',
      body: 'body',
    })
    const r = await m.renameAutoMemory({
      oldFilename: 'before.md',
      newFilename: 'after.md',
    })
    expect(r.ok).toBe(true)
    expect(existsSync(join(tmpMemDir, 'before.md'))).toBe(false)
    expect(existsSync(join(tmpMemDir, 'after.md'))).toBe(true)
    const idx = readFileSync(join(tmpMemDir, 'MEMORY.md'), 'utf-8')
    expect(idx).not.toContain('before.md')
    expect(idx).toContain('- [Stable](after.md) — stable desc')
  })

  test('新名已存在 → 拒絕', async () => {
    const m = await loadMutations()
    await m.createAutoMemory({
      filename: 'a.md',
      name: 'A',
      description: 'A',
      type: 'feedback',
      body: 'body',
    })
    await m.createAutoMemory({
      filename: 'b.md',
      name: 'B',
      description: 'B',
      type: 'feedback',
      body: 'body',
    })
    const r = await m.renameAutoMemory({
      oldFilename: 'a.md',
      newFilename: 'b.md',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('已存在')
  })
})

describe('readFileWithFrontmatter', () => {
  test('parse frontmatter + 抽 body', async () => {
    const m = await loadMutations()
    await m.createAutoMemory({
      filename: 'rd.md',
      name: 'R',
      description: 'R desc',
      type: 'reference',
      body: 'real body line\nsecond',
    })
    const out = await m.readFileWithFrontmatter(join(tmpMemDir, 'rd.md'))
    expect(out.fm.name).toBe('R')
    expect(out.fm.description).toBe('R desc')
    expect(out.fm.type).toBe('reference')
    expect(out.body).toBe('real body line\nsecond\n')
  })
})

describe('createLocalConfig + renameLocalConfig', () => {
  test('create + rename', async () => {
    const m = await loadMutations()
    const r1 = await m.createLocalConfig({
      cwd: tmpCwd,
      filename: 'rules.md',
      body: 'rule body',
    })
    expect(r1.ok).toBe(true)
    expect(existsSync(join(tmpCwd, '.my-agent', 'rules.md'))).toBe(true)
    const r2 = await m.renameLocalConfig({
      cwd: tmpCwd,
      oldFilename: 'rules.md',
      newFilename: 'policies.md',
    })
    expect(r2.ok).toBe(true)
    expect(existsSync(join(tmpCwd, '.my-agent', 'rules.md'))).toBe(false)
    expect(existsSync(join(tmpCwd, '.my-agent', 'policies.md'))).toBe(true)
  })
})
