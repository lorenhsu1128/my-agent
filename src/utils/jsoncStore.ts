/**
 * JSONC 讀寫封裝。
 *
 * 設計目的：
 *   - my-agent 的設定檔（llamacpp.json / discord.json / scheduled_tasks.json
 *     / .my-agent.json）從嚴格 JSON 改為 JSONC（允許 // 與 /* *\/ 註解），
 *     使用者可直接在 JSON 內看到每個欄位的繁體中文解釋。
 *   - 寫回（更新欄位值）必須**保留註解**，否則使用者的註解會被 my-agent
 *     例行寫回（如 lastCost / numStartups / skillUsage）洗光。
 *
 * 實作基礎：jsonc-parser 套件（^3.3.1，已在 package.json dependencies）。
 *   - parse(text) 忽略註解產出物件
 *   - modify(text, path, value, opts) 回 Edit[] 保留原文格式與註解
 *   - applyEdits(text, edits) 套用 Edit[] 得新文字
 *
 * 公開 API：
 *   - parseJsonc<T>(text) — 解析 JSONC 字串（容錯：JSON 錯直接 throw）
 *   - readJsoncFile<T>(path) — 讀檔並解析（檔案不存在回 null）
 *   - writeJsoncPreservingComments(path, originalText, newValue) — 保留註解寫回
 *   - initJsoncFile(path, templateText) — 首次落盤（原子）
 *   - diffPaths(oldObj, newObj) — 回變更清單（供外部組裝自訂寫回邏輯）
 *
 * 寫回策略：
 *   1. deep diff 新舊物件，找出所有變更路徑
 *   2. 對每個路徑呼叫 jsonc.modify 累積 Edit[]
 *   3. jsonc.applyEdits 套用得到新文字
 *   4. atomic write（tempfile + rename）落盤
 *
 * Edge cases：
 *   - 陣列整個換值 → 走整陣列 replace（path 指父節點）
 *   - 巢狀物件部分欄位變更 → 遞迴找最細路徑（每個葉子節點一個 edit）
 *   - key 刪除 → modify(path, undefined)
 *   - 新增 key → modify(path, value) 會 append 到父物件末尾（新增的 key 無註解，符合預期）
 *   - 型別改變（object → primitive 等） → 整個 replace
 */
import { existsSync } from 'fs'
import { readFile, rename, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import * as jsonc from 'jsonc-parser'

const FORMATTING_OPTIONS: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
}

/**
 * 解析 JSONC 字串為物件。
 *
 * 容錯：allowTrailingComma + allowEmptyContent；語法錯誤累積在 errors
 * 陣列，若非空則 throw（避免 silent 拿到部分解析結果）。
 */
export function parseJsonc<T = unknown>(text: string): T {
  const errors: jsonc.ParseError[] = []
  const result = jsonc.parse(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
    disallowComments: false,
  }) as T
  if (errors.length > 0) {
    const first = errors[0]!
    const code = jsonc.printParseErrorCode(first.error)
    throw new Error(
      `JSONC 解析失敗（offset ${first.offset}, length ${first.length}）：${code}`,
    )
  }
  return result
}

/**
 * 同步讀取 JSONC 檔。檔案不存在回 null。
 *
 * BOM（U+FEFF）會被自動剝除（某些 Windows 編輯器會加）。
 */
export function readJsoncFileSync<T = unknown>(
  path: string,
): { text: string; parsed: T } | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8').replace(/^﻿/, '')
  return { text: raw, parsed: parseJsonc<T>(raw) }
}

/**
 * 非同步讀取 JSONC 檔。檔案不存在回 null。
 */
export async function readJsoncFile<T = unknown>(
  path: string,
): Promise<{ text: string; parsed: T } | null> {
  if (!existsSync(path)) return null
  const raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
  return { text: raw, parsed: parseJsonc<T>(raw) }
}

/**
 * Deep diff：比對 oldObj 與 newObj，回傳所有需要變更的路徑清單。
 *
 * 規則：
 *   - 兩邊都是 plain object → 遞迴
 *   - 型別不同 / 陣列 / primitive → 在當前 path 回一個 entry（整個 replace）
 *   - old 有 new 沒有 → 回 value=undefined（表示刪除）
 *   - new 有 old 沒有 → 回 value=newObj
 *
 * 回傳順序：先處理較深路徑，再處理較淺（避免父物件被替換後子路徑 offset 錯亂）。
 */
export function diffPaths(
  oldObj: unknown,
  newObj: unknown,
  basePath: jsonc.JSONPath = [],
): Array<{ path: jsonc.JSONPath; value: unknown }> {
  // 完全相同（含 primitive 與 reference）
  if (oldObj === newObj) return []

  // 型別不同或其中一方為 null → 整個 replace
  const oldIsPlain = isPlainObject(oldObj)
  const newIsPlain = isPlainObject(newObj)
  if (!oldIsPlain || !newIsPlain) {
    // 陣列、primitive、null 等 → 整個 replace（或 delete if newObj === undefined）
    if (basePath.length === 0) {
      // 根節點換型別/陣列 — 外層不應該這樣呼叫（整檔應重寫），但保險起見回一個根 replace
      return [{ path: [], value: newObj }]
    }
    return [{ path: basePath, value: newObj }]
  }

  // 兩邊都是 plain object → 遞迴
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = []
  const oldKeys = new Set(Object.keys(oldObj as Record<string, unknown>))
  const newKeys = new Set(Object.keys(newObj as Record<string, unknown>))

  // 刪除的 key（old 有 new 沒有）
  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      edits.push({ path: [...basePath, key], value: undefined })
    }
  }

  // 新增或變更的 key
  for (const key of newKeys) {
    const oldVal = (oldObj as Record<string, unknown>)[key]
    const newVal = (newObj as Record<string, unknown>)[key]
    if (!oldKeys.has(key)) {
      // 新增
      edits.push({ path: [...basePath, key], value: newVal })
    } else {
      // 變更 — 遞迴
      edits.push(...diffPaths(oldVal, newVal, [...basePath, key]))
    }
  }

  return edits
}

/**
 * 保留註解地寫回 JSONC 檔。
 *
 * 流程：
 *   1. parseJsonc(originalText) 得 oldObj
 *   2. diffPaths(oldObj, newValue) 找所有變更
 *   3. 逐路徑 jsonc.modify 累積 Edit
 *   4. jsonc.applyEdits 得新文字
 *   5. atomic write（tempfile → rename）
 *
 * 若 newValue 與 oldObj reference equal / deep equal 無變更，不 touch 檔案。
 */
export async function writeJsoncPreservingComments<T>(
  path: string,
  originalText: string,
  newValue: T,
): Promise<{ newText: string; changed: boolean }> {
  const oldObj = parseJsonc<T>(originalText)
  const edits = diffPaths(oldObj, newValue)
  if (edits.length === 0) {
    return { newText: originalText, changed: false }
  }

  let newText = originalText
  for (const { path: editPath, value } of edits) {
    // 根節點替換（edits 只有一個 path=[]）
    if (editPath.length === 0) {
      newText = stringifyJsoncValue(value)
      break
    }
    const modifyEdits = jsonc.modify(newText, editPath, value, {
      formattingOptions: FORMATTING_OPTIONS,
    })
    newText = jsonc.applyEdits(newText, modifyEdits)
  }

  await atomicWrite(path, newText)
  return { newText, changed: true }
}

/**
 * 首次落盤（atomic）。已存在則不動（尊重使用者編輯與註解）。
 */
export async function initJsoncFile(
  path: string,
  templateText: string,
): Promise<{ created: boolean }> {
  if (existsSync(path)) return { created: false }
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, templateText)
  return { created: true }
}

/**
 * 強制重寫 JSONC 檔（例如 migration 觸發 / /config-rewrite-with-docs）。
 * 寫前先備份為 `<path>.pre-rewrite-<timestamp>`。
 */
export async function forceRewriteJsoncFile(
  path: string,
  newText: string,
): Promise<{ backupPath: string | null }> {
  let backupPath: string | null = null
  if (existsSync(path)) {
    backupPath = `${path}.pre-rewrite-${Date.now()}`
    await writeFile(backupPath, await readFile(path), 'utf-8')
  }
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, newText)
  return { backupPath }
}

/**
 * 原子寫入：先寫 tempfile，再 rename 覆蓋目標。
 * rename 在 POSIX 與 Windows（NTFS）都是原子的。
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, 'utf-8')
  try {
    await rename(tmp, path)
  } catch (err) {
    // Windows 某些情況 rename 無法覆蓋既有檔 — 刪除後重試
    try {
      const { unlink } = await import('fs/promises')
      await unlink(path)
      await rename(tmp, path)
    } catch {
      throw err
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

/**
 * 把任意值序列化為 JSONC 可接受的字串（供根節點 replace 或根本不存在檔時的 fallback）。
 * 沒有註解（根節點 replace 的罕見情境）。
 */
function stringifyJsoncValue(value: unknown): string {
  return JSON.stringify(value, null, FORMATTING_OPTIONS.tabSize) + '\n'
}

// 匯出型別別名供外部使用
export type JsoncPath = jsonc.JSONPath

// 測試專用：允許單獨 export 內部 helper 做單元測試
export const _internals = {
  isPlainObject,
  stringifyJsoncValue,
  atomicWrite,
  FORMATTING_OPTIONS,
}
