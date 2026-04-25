/**
 * saveGlobalConfig 路徑的 JSONC 保留註解行為測試。
 *
 * 覆蓋：saveConfigWithLock 與 saveConfig 兩路 write path。
 * 測試策略：不實際呼叫 saveGlobalConfig（會受 NODE_ENV=test 影響並走記憶體），
 * 而是直接模擬 saveConfigWithLock 內部 jsonc preserve 寫出邏輯做單元驗證。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as jsonc from 'jsonc-parser'
import { diffPaths } from '../../../src/utils/jsoncStore'

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `saveConfig-jsonc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/**
 * 模擬 saveConfigWithLock 新增的 JSONC preserve 邏輯：
 *   1. 讀現檔文字
 *   2. 若有 // 或 /* 註解 → 用 diffPaths + jsonc.modify 套變更
 *   3. 寫回保留註解的新文字
 */
function simulateJsoncPreserve(
  file: string,
  currentParsed: unknown,
  mergedConfig: unknown,
): void {
  const existingRaw = readFileSync(file, 'utf-8').replace(/^﻿/, '')
  if (!/\/\/|\/\*/.test(existingRaw)) {
    throw new Error('Not a JSONC file — test setup bug')
  }
  const edits = diffPaths(currentParsed, mergedConfig)
  let working = existingRaw
  for (const { path: editPath, value } of edits) {
    if (editPath.length === 0) {
      working = JSON.stringify(value, null, 2)
      break
    }
    const modifyEdits = jsonc.modify(working, editPath, value, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
    })
    working = jsonc.applyEdits(working, modifyEdits)
  }
  writeFileSync(file, working, 'utf-8')
}

describe('saveConfig JSONC preserve 行為', () => {
  test('有 // 註解的 config：改變單一欄位保留所有註解', () => {
    const file = join(testDir, 'cfg.json')
    const original = `{
  // 全域註解區塊
  // 多行說明

  // ═══ 功能開關 ═══
  "verbose": false,
  "autoCompactEnabled": true,

  // ═══ 自動維護 ═══
  "numStartups": 100
}`
    writeFileSync(file, original, 'utf-8')

    const current = {
      verbose: false,
      autoCompactEnabled: true,
      numStartups: 100,
    }
    const merged = {
      verbose: false,
      autoCompactEnabled: true,
      numStartups: 101, // turn 結束 +1
    }
    simulateJsoncPreserve(file, current, merged)

    const after = readFileSync(file, 'utf-8')
    expect(after).toContain('// 全域註解區塊')
    expect(after).toContain('// ═══ 功能開關 ═══')
    expect(after).toContain('// ═══ 自動維護 ═══')
    expect(after).toContain('"numStartups": 101')
    expect(after).toContain('"verbose": false')
  })

  test('巢狀欄位寫回：projects[cwd].lastCost 更新不洗父註解', () => {
    const file = join(testDir, 'cfg.json')
    const original = `{
  // 動態容器
  "projects": {
    // 當前專案
    "my-agent": {
      "lastCost": 0,
      "lastSession": "old"
    }
  }
}`
    writeFileSync(file, original, 'utf-8')

    const current = {
      projects: {
        'my-agent': { lastCost: 0, lastSession: 'old' },
      },
    }
    const merged = {
      projects: {
        'my-agent': { lastCost: 42.5, lastSession: 'old' },
      },
    }
    simulateJsoncPreserve(file, current, merged)

    const after = readFileSync(file, 'utf-8')
    expect(after).toContain('// 動態容器')
    expect(after).toContain('// 當前專案')
    expect(after).toContain('"lastCost": 42.5')
    expect(after).toContain('"lastSession": "old"')
  })

  test('同時多欄位變更保留所有註解（模擬 turn 結束 stats 批次寫）', () => {
    const file = join(testDir, 'cfg.json')
    const original = `{
  // 計數欄位（my-agent 自動維護）
  "numStartups": 10,
  "promptQueueUseCount": 5,

  // 使用者偏好
  "verbose": false
}`
    writeFileSync(file, original, 'utf-8')

    const current = {
      numStartups: 10,
      promptQueueUseCount: 5,
      verbose: false,
    }
    const merged = {
      numStartups: 11,
      promptQueueUseCount: 6,
      verbose: false,
    }
    simulateJsoncPreserve(file, current, merged)

    const after = readFileSync(file, 'utf-8')
    expect(after).toContain('// 計數欄位（my-agent 自動維護）')
    expect(after).toContain('// 使用者偏好')
    expect(after).toContain('"numStartups": 11')
    expect(after).toContain('"promptQueueUseCount": 6')
  })

  test('strict JSON 檔（無註解）— 偵測不會觸發 JSONC 路徑', () => {
    const file = join(testDir, 'strict.json')
    writeFileSync(file, '{"numStartups":10}', 'utf-8')
    const raw = readFileSync(file, 'utf-8')
    // 驗證正則偵測邏輯（/\/\/|\/\*/.test）
    const hasJsoncComments = /\/\/|\/\*/.test(raw)
    expect(hasJsoncComments).toBe(false)
  })

  test('JSONC 檔（有 //）— 偵測觸發', () => {
    const file = join(testDir, 'jsonc.json')
    writeFileSync(file, '{\n// 註解\n"a": 1\n}', 'utf-8')
    const raw = readFileSync(file, 'utf-8')
    expect(/\/\/|\/\*/.test(raw)).toBe(true)
  })

  test('JSONC 檔（有 /* */）— 偵測觸發', () => {
    const file = join(testDir, 'jsonc.json')
    writeFileSync(file, '{\n/* 區塊註解 */\n"a": 1\n}', 'utf-8')
    const raw = readFileSync(file, 'utf-8')
    expect(/\/\/|\/\*/.test(raw)).toBe(true)
  })
})
