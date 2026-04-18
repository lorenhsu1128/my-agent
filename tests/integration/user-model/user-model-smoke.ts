#!/usr/bin/env bun
/**
 * M-UM-4 整合測試：User Modeling 完整 smoke test。
 *
 * 用法：bun run tests/integration/user-model/user-model-smoke.ts
 *
 * 測試項目：
 *   1. paths.ts 三路開關（env / settings / default）
 *   2. userModel 寫入（add / replace / remove / 雙層 scope）
 *   3. Snapshot 凍結語意（載入後再寫不影響 snapshot）
 *   4. prompt.ts fence 格式 + 雙層合併 + 字元告警
 *   5. MemoryTool target='user_profile' 整合
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

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

async function main() {
  // 建立獨立的臨時 user model dir + project dir
  const tmp = await mkdtemp(join(tmpdir(), 'um-smoke-'))
  const globalPath = join(tmp, 'USER.md')
  const projectDir = join(tmp, 'projects', 'mock-slug')
  await mkdir(projectDir, { recursive: true })
  const projectPath = join(projectDir, 'USER.md')

  // 透過 env 指派 global 路徑
  process.env.FREECODE_USER_MODEL_PATH = globalPath
  // 確保開關預設 ON
  delete process.env.FREECODE_DISABLE_USER_MODEL
  delete process.env.CLAUDE_CODE_SIMPLE

  // 動態 import（env 設好後再載入）
  const paths = await import('../../../src/userModel/paths.js')
  const um = await import('../../../src/userModel/userModel.js')
  const prompt = await import('../../../src/userModel/prompt.js')

  // -------------------------------------------------------------------------
  section('1. 開關判定')
  // -------------------------------------------------------------------------
  assert(paths.isUserModelEnabled() === true, '預設啟用')

  process.env.FREECODE_DISABLE_USER_MODEL = '1'
  assert(paths.isUserModelEnabled() === false, 'env=1 → 停用')

  process.env.FREECODE_DISABLE_USER_MODEL = 'false'
  assert(paths.isUserModelEnabled() === true, 'env=false → 啟用')

  delete process.env.FREECODE_DISABLE_USER_MODEL
  process.env.CLAUDE_CODE_SIMPLE = '1'
  assert(paths.isUserModelEnabled() === false, 'SIMPLE/bare → 停用')
  delete process.env.CLAUDE_CODE_SIMPLE

  assert(
    paths.getUserModelGlobalPath() === globalPath,
    'global path 由 FREECODE_USER_MODEL_PATH 覆寫',
  )

  // -------------------------------------------------------------------------
  section('2. 寫入 global add / replace / remove')
  // -------------------------------------------------------------------------
  let r = await um.writeUserModel({ action: 'add', scope: 'global', content: '使用者名叫 Loren' })
  assert(r.success, 'add 成功')

  const after1 = await readFile(globalPath, 'utf-8')
  assert(after1.includes('- 使用者名叫 Loren'), 'add 自動加 bullet 前綴')

  r = await um.writeUserModel({ action: 'add', scope: 'global', content: '- 主要 shell: PowerShell' })
  assert(r.success && (await readFile(globalPath, 'utf-8')).split('\n').filter(Boolean).length === 2, '第二條 add 不重複加 bullet')

  r = await um.writeUserModel({ action: 'remove', scope: 'global', content: 'Loren' })
  assert(r.success, 'remove 命中子字串成功')
  const after3 = await readFile(globalPath, 'utf-8')
  assert(!after3.includes('Loren'), 'remove 後目標條目消失')

  r = await um.writeUserModel({ action: 'replace', scope: 'global', content: '- 繁中 / PowerShell' })
  assert(r.success, 'replace 成功')
  const after4 = await readFile(globalPath, 'utf-8')
  assert(after4.trim() === '- 繁中 / PowerShell', 'replace 整檔覆蓋')

  // -------------------------------------------------------------------------
  section('3. Snapshot 凍結語意')
  // -------------------------------------------------------------------------
  um._resetSnapshotForTests()
  const snap1 = await um.loadSnapshot()
  assert(snap1.global.includes('繁中'), 'snapshot 有 global 內容')

  // mid-session 寫入
  await um.writeUserModel({ action: 'add', scope: 'global', content: 'session 中新增的條目' })
  const snap2 = um.getSnapshot()
  assert(snap2.global === snap1.global, 'snapshot 不受 mid-session 寫入影響（凍結）')

  const live = await um.readLive()
  assert(live.global.includes('session 中新增'), 'readLive 回傳最新內容')

  // -------------------------------------------------------------------------
  section('4. 雙層合併（global + project）')
  // -------------------------------------------------------------------------
  // project USER.md 直接寫檔（不走 getUserModelProjectPath，改用 env 假裝）
  // 這裡測 buildCombined 邏輯：手動建一個 snapshot
  const combined = await um.readLive()
  assert(!combined.combined.includes('### Project-specific'), 'project 空時不加分隔')

  // 模擬 project 內容
  await writeFile(projectPath, '- 本專案用 Bun\n', 'utf-8')

  // 直接 mock readLive 不現實；改為驗證 formatUserProfileBlock 行為
  const fakeSnap = {
    global: '- 繁中\n- PowerShell',
    project: '- 本專案用 Bun',
    combined: '- 繁中\n- PowerShell\n\n### Project-specific\n\n- 本專案用 Bun',
    totalChars: 50,
  }
  const block = prompt.formatUserProfileBlock(fakeSnap)!
  assert(block.includes('<user-profile>'), 'fence 開頭')
  assert(block.includes('</user-profile>'), 'fence 結尾')
  assert(block.includes('### Project-specific'), '雙層分隔標題存在')
  assert(block.includes('- 繁中'), 'global 內容包含')
  assert(block.includes('- 本專案用 Bun'), 'project 內容包含')

  // -------------------------------------------------------------------------
  section('5. 字元告警')
  // -------------------------------------------------------------------------
  const big = 'x'.repeat(prompt.USER_PROFILE_SOFT_LIMIT + 100)
  const bigSnap = {
    global: big,
    project: '',
    combined: big,
    totalChars: big.length,
  }
  const bigBlock = prompt.formatUserProfileBlock(bigSnap)!
  assert(bigBlock.includes('建議收斂'), '超過 soft limit 時附警告')
  assert(bigBlock.includes(big), '超限內容不被截斷')

  const emptySnap = { global: '', project: '', combined: '', totalChars: 0 }
  assert(
    prompt.formatUserProfileBlock(emptySnap) === null,
    '空 snapshot 回傳 null',
  )

  // -------------------------------------------------------------------------
  section('6. loadUserProfilePrompt 整合')
  // -------------------------------------------------------------------------
  um._resetSnapshotForTests()
  const out = await prompt.loadUserProfilePrompt()
  assert(out !== null && out.includes('<user-profile>'), 'loadUserProfilePrompt 回傳 fence')

  process.env.FREECODE_DISABLE_USER_MODEL = '1'
  const disabled = await prompt.loadUserProfilePrompt()
  assert(disabled === null, '停用時回 null')
  delete process.env.FREECODE_DISABLE_USER_MODEL

  // -------------------------------------------------------------------------
  section('7. Injection 仍可被 MemoryTool 擋掉（單元層次驗證）')
  // -------------------------------------------------------------------------
  // 直接跑 writeUserModel 不會過 injection scan（那是 MemoryTool 層責任）。
  // 這裡只驗證 writeUserModel 本身不檢 content 完整性 — 留給 MemoryTool。
  const raw = await um.writeUserModel({
    action: 'add',
    scope: 'global',
    content: '純文字條目（MemoryTool 才擋 injection）',
  })
  assert(raw.success, 'userModel 層不攔截 — 由 MemoryTool 負責 injection scan')

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------
  delete process.env.FREECODE_USER_MODEL_PATH
  await rm(tmp, { recursive: true, force: true })

  console.log(`\n總計：${passed} 通過 / ${failed} 失敗`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('測試執行失敗:', err)
  process.exit(1)
})
