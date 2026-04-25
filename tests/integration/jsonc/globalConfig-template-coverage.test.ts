/**
 * GlobalConfig bundled 模板覆蓋率測試。
 *
 * 目的：防止新增 GlobalConfig 欄位時忘記同步更新
 * src/globalConfig/bundledTemplate.ts — 那會讓使用者 seed 出來的檔案
 * 少了新欄位的繁中註解。
 *
 * 覆蓋規則：
 *   - createDefaultGlobalConfig() 產出的每個 top-level key 都必須在模板中
 *     「被提及」— 定義如下：
 *     (a) 以 JSON key 形式出現（template parse 後在 Object.keys 中），或
 *     (b) 以註解形式出現（例如 `// "userID": "..."` — 敏感欄位模板預設
 *         註解掉不填值，但名稱仍可見於註解讓使用者知道此欄位存在）
 *
 *   - 若 DEFAULT_GLOBAL_CONFIG 的 key 不符合以上兩種情況 → 測試失敗，
 *     明確列出漏掉的 key，提示去補 bundledTemplate.ts 的註解。
 *
 * 不檢查的面向（刻意留寬）：
 *   - 巢狀欄位（不遞迴進 projects / cachedGrowthBookFeatures / 等容器）
 *   - 模板中額外的 key（例如 Claude Code 遺留欄位註解，不在 default 裡也 OK）
 *   - GLOBAL_CONFIG_KEYS 陣列（可選 — 多數是 default 子集）
 */
import { describe, expect, test } from 'bun:test'
import { GLOBAL_CONFIG_JSONC_TEMPLATE } from '../../../src/globalConfig/bundledTemplate'
import { parseJsonc } from '../../../src/utils/jsoncStore'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
} from '../../../src/utils/config'

/**
 * 從 JSONC 模板文字抽出所有「被提及的 top-level key 名稱」：
 *   - 實際 JSON key → parseJsonc 結果的 Object.keys
 *   - 註解中的 key 引用 → regex 匹配 `// "keyName":` 或 `"keyName":` 在
 *     註解行內
 */
function extractDocumentedKeys(templateText: string): Set<string> {
  const documented = new Set<string>()

  // (a) 實際 JSON key
  try {
    const parsed = parseJsonc<Record<string, unknown>>(templateText)
    for (const key of Object.keys(parsed)) {
      documented.add(key)
    }
  } catch {
    throw new Error('模板本身不是合法 JSONC — 先修模板語法')
  }

  // (b) 註解中的 key 引用：匹配以 // 開頭的行內 "key": 或 "key" 這類引用
  // 範例： // "userID": "<自動產生>",
  //       // "installMethod": "unknown",
  const commentKeyPattern = /\/\/[^\n]*"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g
  let match: RegExpExecArray | null
  while ((match = commentKeyPattern.exec(templateText)) !== null) {
    documented.add(match[1]!)
  }

  // (c) 多行 /* */ 註解內也可能有 key 提及 — 用較寬鬆的 regex 匹配
  //     /* ... "keyName" ... */
  const blockPattern = /\/\*[\s\S]*?\*\//g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockPattern.exec(templateText)) !== null) {
    const block = blockMatch[0]
    const inner = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g
    let m: RegExpExecArray | null
    while ((m = inner.exec(block)) !== null) {
      documented.add(m[1]!)
    }
  }

  return documented
}

describe('GlobalConfig template 覆蓋率', () => {
  test('模板本身是合法 JSONC', () => {
    expect(() => parseJsonc(GLOBAL_CONFIG_JSONC_TEMPLATE)).not.toThrow()
  })

  test('createDefaultGlobalConfig 所有 top-level key 都有在模板中被提及', () => {
    const documented = extractDocumentedKeys(GLOBAL_CONFIG_JSONC_TEMPLATE)
    const defaults = Object.keys(DEFAULT_GLOBAL_CONFIG)
    const missing = defaults.filter(k => !documented.has(k))
    if (missing.length > 0) {
      // 使用 assertion message 清楚告訴下一個 contributor 怎麼修
      const msg =
        `以下 GlobalConfig 欄位在 createDefaultGlobalConfig() 有定義，\n` +
        `但 src/globalConfig/bundledTemplate.ts 沒有為它加註解：\n\n` +
        missing.map(k => `  - ${k}`).join('\n') +
        `\n\n修法：在 bundledTemplate.ts 對應 section 加一條 // 註解解釋此\n` +
        `欄位用途、預設值、是否 my-agent 自動維護、legacy 與否。範例：\n\n` +
        `  // <繁體中文說明：做什麼、預設值、何時生效>\n` +
        `  "${missing[0]}": <預設值>,\n\n` +
        `敏感欄位（token / userID 等）可用 "// <註解掉的 key>:" 形式保留\n` +
        `提示使用者有此欄位但不填具體值。`
      throw new Error(msg)
    }
    expect(missing).toEqual([])
  })

  test('GLOBAL_CONFIG_KEYS（使用者可編輯欄位）也都在模板中被提及', () => {
    const documented = extractDocumentedKeys(GLOBAL_CONFIG_JSONC_TEMPLATE)
    const missing = GLOBAL_CONFIG_KEYS.filter(k => !documented.has(k))
    if (missing.length > 0) {
      const msg =
        `以下 GLOBAL_CONFIG_KEYS（/config 可編輯 key）未在 bundledTemplate 提及：\n\n` +
        missing.map(k => `  - ${k}`).join('\n') +
        `\n\n這些是使用者最常手改的欄位，務必在模板中有繁中註解說明。`
      throw new Error(msg)
    }
    expect(missing).toEqual([])
  })

  test('模板的 §7 Claude Code 遺留段落仍列出核心 legacy 欄位', () => {
    // 避免未來有人「整理」模板時不小心刪掉 legacy 區塊；確保 4 個典型
    // legacy key 仍在註解裡看得到。
    const documented = extractDocumentedKeys(GLOBAL_CONFIG_JSONC_TEMPLATE)
    const expectedLegacy = [
      'oauthAccount',
      's1mAccessCache',
      'passesEligibilityCache',
      'cachedChromeExtensionInstalled',
    ]
    const missing = expectedLegacy.filter(k => !documented.has(k))
    expect(missing).toEqual([])
  })

  test('模板的主要「使用者功能開關」區塊未被誤刪', () => {
    // 冒煙檢查幾個最常用的 key 一定要被直接放在 JSON（非 comment-only）
    const parsed = parseJsonc<Record<string, unknown>>(
      GLOBAL_CONFIG_JSONC_TEMPLATE,
    )
    const mustExistAsJsonKey = [
      'verbose',
      'autoCompactEnabled',
      'contextSize',
      'daemonAutoStart',
      'numStartups',
      'projects',
      'githubRepoPaths',
    ]
    const missing = mustExistAsJsonKey.filter(k => !(k in parsed))
    expect(missing).toEqual([])
  })
})
