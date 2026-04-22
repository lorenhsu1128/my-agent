#!/usr/bin/env bun
/**
 * M-DELETE-10 smoke：Discord 不允許觸發刪除類 slash commands。
 *
 * 這不走真實 Discord gateway，而是模擬 gateway 內的 blacklist 邏輯單元。
 * 實機驗證需要活 bot → 手動測試。
 *
 * bun run tests/integration/delete/discord-blacklist-smoke.ts
 */

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

// 複製 gateway.ts 的黑名單判定邏輯（保持同步）
function isBlacklisted(prompt: string): boolean {
  const replOnlyCommands = ['/session-delete', '/memory-delete', '/trash']
  const head = prompt.trimStart()
  return replOnlyCommands.some(cmd => head.startsWith(cmd))
}

console.log('── Discord blacklist 判定邏輯 ──')

assert(isBlacklisted('/session-delete'), '/session-delete')
assert(isBlacklisted('/memory-delete'), '/memory-delete')
assert(isBlacklisted('/trash'), '/trash')
assert(isBlacklisted('  /trash'), '前置空白仍命中')
assert(isBlacklisted('/session-delete some-id'), '帶參數仍命中')

assert(!isBlacklisted('hello'), '普通訊息不命中')
assert(!isBlacklisted('/status'), '允許 /status')
assert(!isBlacklisted('/mode acceptEdits'), '允許 /mode')
assert(!isBlacklisted('talk about /trash'), '中段出現不命中')
assert(!isBlacklisted(''), '空字串不命中')

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`)
process.exit(failed > 0 ? 1 : 0)
