#!/usr/bin/env bun
/**
 * M-DELETE-4+5 smoke：memoryDelete helpers + memoryList reader。
 *
 * bun run tests/integration/delete/memory-ops-smoke.ts
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  softDeleteMemoryEntry,
  softDeleteStandaloneFile,
  removeMemoryIndexLine,
  assertSafeMemoryFilename,
} from '../../../src/utils/memoryDelete.js'
import { listTrash } from '../../../src/utils/trash/index.js'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

const testRoot = join(tmpdir(), `my-agent-memop-test-${Date.now()}`)
mkdirSync(testRoot, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(testRoot, '.my-agent')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const cwd = testRoot
const memDir = join(testRoot, 'mem')
mkdirSync(memDir, { recursive: true })

try {
  // -----------------------------------------------------------------
  section('assertSafeMemoryFilename')
  // -----------------------------------------------------------------
  assert(
    assertSafeMemoryFilename('user_role.md', memDir) ===
      join(memDir, 'user_role.md'),
    '合法 filename 回完整路徑',
  )
  const badCases = [
    ['', 'empty'],
    ['user_role', 'no .md'],
    ['../../etc/passwd.md', 'path traversal ../'],
    ['a/b.md', 'contains slash'],
    ['a\\b.md', 'contains backslash'],
    ['null\0.md', 'null byte'],
    ['MEMORY.md', 'index file'],
  ] as const
  for (const [bad, why] of badCases) {
    let threw = false
    try {
      assertSafeMemoryFilename(bad, memDir)
    } catch {
      threw = true
    }
    assert(threw, `拒絕 ${why}`)
  }

  // -----------------------------------------------------------------
  section('removeMemoryIndexLine')
  // -----------------------------------------------------------------
  const indexPath = join(memDir, 'MEMORY.md')
  writeFileSync(
    indexPath,
    [
      '- [User Role](user_role.md) — data scientist',
      '- [Testing](feedback_test.md) — integration tests first',
      '- [Other](project_misc.md) — misc stuff',
    ].join('\n'),
  )
  assert(
    removeMemoryIndexLine(memDir, 'feedback_test.md') === true,
    'remove 中間那行',
  )
  const after = readFileSync(indexPath, 'utf-8')
  assert(!after.includes('feedback_test.md'), '被刪的不再出現')
  assert(after.includes('user_role.md'), '其他行保留 1')
  assert(after.includes('project_misc.md'), '其他行保留 2')

  assert(
    removeMemoryIndexLine(memDir, 'nonexistent.md') === false,
    '不存在 → false',
  )

  // 沒 MEMORY.md 時
  const emptyDir = join(testRoot, 'empty-mem')
  mkdirSync(emptyDir)
  assert(
    removeMemoryIndexLine(emptyDir, 'x.md') === false,
    '無 MEMORY.md → false',
  )

  // -----------------------------------------------------------------
  section('softDeleteMemoryEntry')
  // -----------------------------------------------------------------
  const entry1 = join(memDir, 'user_role.md')
  writeFileSync(
    entry1,
    '---\nname: user_role\ndescription: data scientist\ntype: user\n---\n\nbody',
  )
  const entry2 = join(memDir, 'project_misc.md')
  writeFileSync(
    entry2,
    '---\nname: misc\ndescription: misc stuff\ntype: project\n---\n\nbody',
  )

  const res1 = softDeleteMemoryEntry({
    cwd,
    memDir,
    filename: 'user_role.md',
  })
  assert(!existsSync(entry1), '原檔已搬離')
  assert(res1.indexLineRemoved === true, '索引行已移除')
  assert(res1.trashId.startsWith('memory-'), 'trashId 以 memory- 開頭')

  const idx2 = readFileSync(indexPath, 'utf-8')
  assert(!idx2.includes('user_role.md'), 'MEMORY.md 不再含 user_role.md')
  assert(idx2.includes('project_misc.md'), 'project_misc.md 仍在索引')

  const trashItems = listTrash(cwd)
  assert(
    trashItems.length === 1 && trashItems[0].kind === 'memory',
    'trash 有 1 個 memory entry',
  )

  // 刪不存在的檔 → throw
  let threw = false
  try {
    softDeleteMemoryEntry({ cwd, memDir, filename: 'ghost.md' })
  } catch {
    threw = true
  }
  assert(threw, '不存在 → throw')

  // -----------------------------------------------------------------
  section('softDeleteStandaloneFile')
  // -----------------------------------------------------------------
  const standalone = join(testRoot, 'MY-AGENT.md')
  writeFileSync(standalone, '# Project memory\n')
  const res3 = softDeleteStandaloneFile({
    cwd,
    sourcePath: standalone,
    kind: 'project-memory',
  })
  assert(!existsSync(standalone), 'MY-AGENT.md 已搬離')
  assert(
    res3.trashId.startsWith('project-memory-'),
    'trashId 以 project-memory- 開頭',
  )

  let threw2 = false
  try {
    softDeleteStandaloneFile({
      cwd,
      sourcePath: join(testRoot, 'ghost.md'),
      kind: 'daily-log',
    })
  } catch {
    threw2 = true
  }
  assert(threw2, '不存在 → throw')

  // -----------------------------------------------------------------
  section('memoryList — 基本結構（獨立 cwd）')
  // -----------------------------------------------------------------
  // 為了避免跟真實 ~/.my-agent 串場，直接 import mock 測試環境下
  // getAutoMemPath 仍會讀 CLAUDE_CONFIG_DIR 下計算的 projects/<slug>/memory
  // 這裡我們只驗證 listAllMemoryEntries 對非 auto-memory 類能列出
  const cwd2 = join(testRoot, 'proj2')
  mkdirSync(cwd2, { recursive: true })
  writeFileSync(join(cwd2, 'MY-AGENT.md'), '# project-memory-x\n')
  mkdirSync(join(cwd2, '.my-agent'))
  writeFileSync(join(cwd2, '.my-agent', 'note1.md'), '# local note\n')
  writeFileSync(join(cwd2, '.my-agent', 'note2.md'), '# local note 2\n')

  // 動態 import 以確保使用當前 env
  const { listAllMemoryEntries } = await import(
    '../../../src/utils/memoryList.ts'
  )
  const entries = listAllMemoryEntries(cwd2)
  const kinds = entries.map(e => e.kind)
  assert(kinds.includes('project-memory'), '有 project-memory kind')
  assert(
    entries.filter(e => e.kind === 'local-config').length === 2,
    '有 2 個 local-config',
  )
  const pm = entries.find(e => e.kind === 'project-memory')!
  assert(pm.displayName.includes('MY-AGENT.md'), 'displayName 含檔名')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`)
process.exit(failed > 0 ? 1 : 0)
