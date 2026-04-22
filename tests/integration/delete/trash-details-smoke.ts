#!/usr/bin/env bun
/**
 * TrashMeta.details 凍結資訊 + 序列化 round-trip。
 *
 * 驗證：
 *   1. moveToTrash 寫 details 進 meta.json
 *   2. listTrash 讀回 details 完整
 *   3. details.subKind / displayName / firstUserMessage 等 optional 欄位保留
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  moveToTrash,
  listTrash,
  readTrashMeta,
} from '../../../src/utils/trash/index.js'

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

const testRoot = join(tmpdir(), `my-agent-details-test-${Date.now()}`)
mkdirSync(testRoot, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(testRoot, '.my-agent-config')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const cwd = testRoot

try {
  section('Session details round-trip')
  const f1 = join(testRoot, 'session-abc.jsonl')
  writeFileSync(f1, '{"type":"user","message":{}}\n')
  const m1 = moveToTrash({
    cwd,
    kind: 'session',
    sourcePath: f1,
    label: 'session-abc.jsonl',
    details: {
      sessionId: 'session-abc',
      firstUserMessage: 'how do I use discord gateway?',
      model: 'qwen3.5-9b-neo',
      messageCount: 42,
      startedAt: 1714000000000,
      estimatedCostUsd: 0.87,
      subKind: 'transcript',
    },
  })
  assert(m1.details !== undefined, '回傳的 meta 有 details')
  assert(
    m1.details?.firstUserMessage === 'how do I use discord gateway?',
    'firstUserMessage 保留',
  )
  assert(m1.details?.model === 'qwen3.5-9b-neo', 'model 保留')
  assert(m1.details?.messageCount === 42, 'messageCount 保留')
  assert(m1.details?.subKind === 'transcript', 'subKind 保留')

  // 從磁碟 round-trip
  const readBack = readTrashMeta(cwd, m1.id)
  assert(readBack !== null, 'readTrashMeta 回到值')
  assert(
    readBack?.details?.firstUserMessage === 'how do I use discord gateway?',
    'disk round-trip firstUserMessage',
  )
  assert(readBack?.details?.estimatedCostUsd === 0.87, 'disk cost 保留')

  // listTrash 也能讀到
  const list = listTrash(cwd)
  assert(list.length === 1, 'list 有 1 筆')
  assert(list[0].details?.messageCount === 42, 'list 帶回 details')

  section('Memory details round-trip')
  const f2 = join(testRoot, 'user_role.md')
  writeFileSync(f2, 'test')
  const m2 = moveToTrash({
    cwd,
    kind: 'memory',
    sourcePath: f2,
    label: 'user_role.md',
    details: {
      displayName: '[user] user_role',
      description: 'data scientist focused on observability',
      subKind: 'auto-memory',
    },
  })
  assert(
    m2.details?.displayName === '[user] user_role',
    'memory displayName 保留',
  )
  assert(m2.details?.subKind === 'auto-memory', 'memory subKind 保留')

  section('無 details 時 meta 仍可讀')
  const f3 = join(testRoot, 'plain.txt')
  writeFileSync(f3, 'x')
  const m3 = moveToTrash({ cwd, kind: 'memory', sourcePath: f3 })
  assert(m3.details === undefined, '沒傳 details → 欄位省略')
  const readBack3 = readTrashMeta(cwd, m3.id)
  assert(readBack3 !== null, '仍能讀')
  assert(readBack3?.details === undefined, 'disk 無 details 欄位')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`)
process.exit(failed > 0 ? 1 : 0)
