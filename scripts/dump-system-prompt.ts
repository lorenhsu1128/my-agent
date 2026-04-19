#!/usr/bin/env bun
/**
 * M-SP-1 dump-system-prompt.ts
 *
 * 產出當前 session 會送給 LLM 的 system prompt 各段落，方便：
 *   - 驗證外部化前後 byte-level 一致（重構期回歸測試）
 *   - 排錯使用者編輯 .md 後實際注入內容
 *
 * 用法：
 *   bun scripts/dump-system-prompt.ts                    # stdout
 *   bun scripts/dump-system-prompt.ts > /tmp/prompt.txt  # 存檔
 *   bun scripts/dump-system-prompt.ts --no-external      # 跳過讀 .my-agent，只看 bundled
 *
 * 注意：本腳本繞過 getSystemPrompt() 組裝（涉及工具註冊表 / MCP / output style），
 * 只輸出靜態 + 已外部化的各段，足夠驗證 M-SP 範圍。
 */
import {
  seedSystemPromptDirIfMissing,
  loadSystemPromptSnapshot,
  _resetSystemPromptSnapshotForTests,
  SECTIONS,
  getSection,
  getBundledDefault,
} from '../src/systemPromptFiles/index.js'

async function main() {
  const skipExternal = process.argv.includes('--no-external')

  if (skipExternal) {
    console.log('# ===== dump-system-prompt (bundled only) =====\n')
    for (const s of SECTIONS) {
      if (!s.externalized) continue
      const content = getBundledDefault(s.id) ?? '<NO BUNDLED DEFAULT>'
      console.log(`\n## ----- ${s.id} (${s.filename}) -----\n`)
      console.log(content)
    }
    return
  }

  console.log('# ===== dump-system-prompt (live) =====\n')
  _resetSystemPromptSnapshotForTests()
  await seedSystemPromptDirIfMissing()
  await loadSystemPromptSnapshot()

  for (const s of SECTIONS) {
    if (!s.externalized) continue
    const content = getSection(s.id)
    console.log(`\n## ----- ${s.id} (${s.filename}) -----\n`)
    if (content === null) {
      console.log('<NOT LOADED — would fallback to bundled/original in prompts.ts>')
    } else {
      console.log(content)
    }
  }

  console.log('\n# ===== not-yet-externalized sections =====')
  for (const s of SECTIONS) {
    if (s.externalized) continue
    console.log(`- ${s.id} (${s.filename}) — ${s.purpose}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
