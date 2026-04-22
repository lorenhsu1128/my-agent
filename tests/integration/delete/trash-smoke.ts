#!/usr/bin/env bun
/**
 * M-DELETE-1 smoke：trash 共用層。
 *
 * bun run tests/integration/delete/trash-smoke.ts
 */
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  moveToTrash,
  restoreFromTrash,
  listTrash,
  readTrashMeta,
  emptyTrash,
  pruneTrash,
  getTrashDir,
  purgeTrashEntry,
  totalTrashSize,
} from '../../../src/utils/trash/index.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

// 必須用一個真實會被 sanitizePath 接受的 cwd。用 tmpdir 底下一個子目錄。
const testRoot = join(tmpdir(), `my-agent-trash-test-${Date.now()}`)
mkdirSync(testRoot, { recursive: true })

// Override CLAUDE_CONFIG_DIR so getProjectDir() 不會動真正的 ~/.my-agent
const configDir = join(testRoot, '.my-agent-config')
process.env.CLAUDE_CONFIG_DIR = configDir
mkdirSync(configDir, { recursive: true })

const cwd = testRoot

try {
  // ---------------------------------------------------------------------------
  section('空 trash 行為')
  // ---------------------------------------------------------------------------
  assert(listTrash(cwd).length === 0, '新 project 沒 trash')
  assert(totalTrashSize(cwd) === 0, '空 trash size=0')
  assert(emptyTrash(cwd).length === 0, '空 trash empty → 回空陣列')
  assert(pruneTrash(cwd, 30).length === 0, '空 trash prune → 回空陣列')
  assert(readTrashMeta(cwd, 'does-not-exist') === null, 'meta 缺檔回 null')

  // ---------------------------------------------------------------------------
  section('單檔 moveToTrash → restore')
  // ---------------------------------------------------------------------------
  const fileA = join(testRoot, 'fileA.txt')
  writeFileSync(fileA, 'hello A')
  const metaA = moveToTrash({
    cwd,
    kind: 'session',
    sourcePath: fileA,
    label: 'test-session-A',
  })
  assert(!existsSync(fileA), '原檔案已不存在')
  assert(metaA.kind === 'session', 'meta.kind 正確')
  assert(metaA.label === 'test-session-A', 'meta.label 保留')
  assert(metaA.sizeBytes === 7, 'meta.sizeBytes = 7 bytes')
  assert(metaA.id.startsWith('session-'), 'id 以 kind 開頭')

  const listed = listTrash(cwd)
  assert(listed.length === 1, 'listTrash 看到 1 個 entry')
  assert(listed[0].id === metaA.id, 'listed 的 id 對得上')

  const restored = restoreFromTrash(cwd, metaA.id)
  assert(existsSync(fileA), 'restore 後原檔重現')
  assert(readFileSync(fileA, 'utf8') === 'hello A', '內容正確')
  assert(restored.id === metaA.id, 'restore 回傳 meta')
  assert(listTrash(cwd).length === 0, 'restore 後 trash 空')

  // ---------------------------------------------------------------------------
  section('目錄 moveToTrash')
  // ---------------------------------------------------------------------------
  const dirB = join(testRoot, 'sessionBlob')
  mkdirSync(dirB)
  writeFileSync(join(dirB, 'a.jsonl'), '{"ok":1}\n{"ok":2}\n')
  writeFileSync(join(dirB, 'b.jsonl'), 'x'.repeat(100))
  const metaB = moveToTrash({ cwd, kind: 'session', sourcePath: dirB })
  assert(!existsSync(dirB), '目錄已搬離')
  assert(metaB.sizeBytes && metaB.sizeBytes >= 100, '目錄 size 合理')

  restoreFromTrash(cwd, metaB.id)
  assert(existsSync(join(dirB, 'a.jsonl')), '目錄復原 a.jsonl')
  assert(existsSync(join(dirB, 'b.jsonl')), '目錄復原 b.jsonl')
  rmSync(dirB, { recursive: true, force: true })

  // ---------------------------------------------------------------------------
  section('restore 衝突保護')
  // ---------------------------------------------------------------------------
  const fileC = join(testRoot, 'conflict.txt')
  writeFileSync(fileC, 'v1')
  const metaC = moveToTrash({ cwd, kind: 'memory', sourcePath: fileC })
  writeFileSync(fileC, 'v2 new content') // 原位置再度有東西

  let threw = false
  try {
    restoreFromTrash(cwd, metaC.id)
  } catch {
    threw = true
  }
  assert(threw, '衝突時預設 throw')
  assert(existsSync(fileC), '未被覆寫')
  assert(readFileSync(fileC, 'utf8') === 'v2 new content', 'v2 保留')

  // overwrite=true 允許覆蓋
  restoreFromTrash(cwd, metaC.id, { overwrite: true })
  assert(readFileSync(fileC, 'utf8') === 'v1', 'overwrite 後變 v1')
  rmSync(fileC)

  // ---------------------------------------------------------------------------
  section('emptyTrash / purge')
  // ---------------------------------------------------------------------------
  const f1 = join(testRoot, 'x1.txt')
  const f2 = join(testRoot, 'x2.txt')
  writeFileSync(f1, '1')
  writeFileSync(f2, '2')
  const m1 = moveToTrash({ cwd, kind: 'session', sourcePath: f1 })
  const m2 = moveToTrash({ cwd, kind: 'memory', sourcePath: f2 })
  assert(listTrash(cwd).length === 2, 'trash 有 2 個')
  purgeTrashEntry(cwd, m1.id)
  assert(listTrash(cwd).length === 1, 'purge 後剩 1')
  const emptied = emptyTrash(cwd)
  assert(emptied.includes(m2.id), 'empty 回傳包含 m2')
  assert(listTrash(cwd).length === 0, 'emptyTrash 後全空')

  // ---------------------------------------------------------------------------
  section('pruneTrash')
  // ---------------------------------------------------------------------------
  const fOld = join(testRoot, 'old.txt')
  writeFileSync(fOld, 'old')
  const mOld = moveToTrash({ cwd, kind: 'session', sourcePath: fOld })
  // 手動 backdate meta
  const metaPath = join(getTrashDir(cwd), mOld.id, 'meta.json')
  const m = JSON.parse(readFileSync(metaPath, 'utf8'))
  m.createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000 // 40 天前
  writeFileSync(metaPath, JSON.stringify(m))

  const fNew = join(testRoot, 'new.txt')
  writeFileSync(fNew, 'new')
  const mNew = moveToTrash({ cwd, kind: 'session', sourcePath: fNew })

  const pruned = pruneTrash(cwd, 30)
  assert(pruned.length === 1, 'prune 只動 1 筆')
  assert(pruned[0] === mOld.id, '被刪的是 old')
  assert(listTrash(cwd).length === 1, '剩 1 筆')
  assert(listTrash(cwd)[0].id === mNew.id, '留下的是 new')

  // 負數天數 → no-op
  assert(pruneTrash(cwd, -1).length === 0, '負天數 no-op')

  // ---------------------------------------------------------------------------
  section('moveToTrash 對不存在的 source 報錯')
  // ---------------------------------------------------------------------------
  let threw2 = false
  try {
    moveToTrash({ cwd, kind: 'session', sourcePath: join(testRoot, 'ghost') })
  } catch {
    threw2 = true
  }
  assert(threw2, '不存在 source → throw')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`)
process.exit(failed > 0 ? 1 : 0)
