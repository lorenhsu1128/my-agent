/**
 * System Prompt Externalization — Project-level Override / Append（M-SP-FULL Phase 2）
 *
 * 兩個 sibling 檔（與 system-prompt/ 子目錄同層）讓使用者「一檔換整個人格」：
 *
 *   ~/.my-agent/projects/<slug>/system-prompt-override.md  ← 完全替代 default
 *   ~/.my-agent/projects/<slug>/system-prompt-append.md    ← 追加在最後
 *   ~/.my-agent/system-prompt-override.md                  ← global override
 *   ~/.my-agent/system-prompt-append.md                    ← global append
 *
 * 解析順序：per-project > global > 無。Override 與 append 各自獨立。
 *
 * 與 sections.ts 的 29 個 section 不同，這兩個檔不被 seed 進預設模板（除了
 * override.md 在 seed 階段會用 default 拼出來當起點，見 seed.ts）。
 * 空字串視為「使用者明確不啟用」（不傳給 runner）。
 *
 * Per-cwd 快取模式與 snapshot 一致：daemon 多 project 共存時各自獨立。
 */
import { readFile } from 'fs/promises'
import {
  getOverrideProjectFileForCwd,
  getAppendProjectFileForCwd,
  getOverrideGlobalFile,
  getAppendGlobalFile,
  getProjectSlugForCwd,
} from './paths.js'

export interface ProjectPromptOverrides {
  /** 完全替代 default 主 prompt（對應 ask() 的 customSystemPrompt） */
  override?: string
  /** 追加在最後（對應 ask() 的 appendSystemPrompt） */
  append?: string
}

const EMPTY_OVERRIDES: ProjectPromptOverrides = {}
const DEFAULT_KEY = '__default__'

const cachedByKey = new Map<string, ProjectPromptOverrides>()
const inFlightByKey = new Map<string, Promise<ProjectPromptOverrides>>()

function keyForCwd(cwd?: string): string {
  return cwd ? getProjectSlugForCwd(cwd) : DEFAULT_KEY
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return raw.replace(/^﻿/, '')
  } catch {
    return null
  }
}

/**
 * 把純註解 / 純空白視為「未啟用」（不啟動 override / append 通道）。
 *
 * 動機：使用者想暫時停用又懶得刪檔時，可整檔註解掉。同樣，append.md 預設
 * 不 seed 但若使用者建空檔加註解也不應該意外注入註解到 LLM。
 *
 * 規則（保守）：strip HTML 註解 `<!-- ... -->` 後若 trim 為空 → 視為未啟用。
 * 否則整段（含原註解）原樣傳給 LLM —— 不 strip 註解避免誤刪使用者刻意保留
 * 的內容。
 */
function isEffectivelyEmpty(raw: string): boolean {
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
  return stripped.trim() === ''
}

function normalize(raw: string | null): string | undefined {
  if (raw === null) return undefined
  if (isEffectivelyEmpty(raw)) return undefined
  return raw
}

async function readLive(cwd: string | undefined): Promise<ProjectPromptOverrides> {
  const overridePath = cwd
    ? getOverrideProjectFileForCwd(cwd)
    : null
  const appendPath = cwd
    ? getAppendProjectFileForCwd(cwd)
    : null

  // per-project（cwd 提供時）→ global fallback
  const [
    overrideProject,
    appendProject,
    overrideGlobal,
    appendGlobal,
  ] = await Promise.all([
    overridePath ? readFileSafe(overridePath) : Promise.resolve(null),
    appendPath ? readFileSafe(appendPath) : Promise.resolve(null),
    readFileSafe(getOverrideGlobalFile()),
    readFileSafe(getAppendGlobalFile()),
  ])

  const override = normalize(overrideProject ?? overrideGlobal)
  const append = normalize(appendProject ?? appendGlobal)

  const result: ProjectPromptOverrides = {}
  if (override !== undefined) result.override = override
  if (append !== undefined) result.append = append
  return result
}

/**
 * 載入 + 凍結指定 cwd 的 override / append。同 cwd 重複呼叫會 hit cache。
 *
 * @param cwd  daemon multi-project 場景傳該 project 的 cwd；REPL / 啟動 setup 不傳。
 */
export async function loadProjectPromptOverrides(
  cwd?: string,
): Promise<ProjectPromptOverrides> {
  const key = keyForCwd(cwd)
  const cached = cachedByKey.get(key)
  if (cached) return cached
  const inFlight = inFlightByKey.get(key)
  if (inFlight) return inFlight
  const promise = readLive(cwd).then(o => {
    cachedByKey.set(key, o)
    inFlightByKey.delete(key)
    return o
  })
  inFlightByKey.set(key, promise)
  return promise
}

/**
 * 同步取已凍結的 overrides。尚未載入回空物件（呼叫端自行處理 default）。
 */
export function getProjectPromptOverrides(
  cwd?: string,
): ProjectPromptOverrides {
  return cachedByKey.get(keyForCwd(cwd)) ?? EMPTY_OVERRIDES
}

/** 測試用：清整個 Map。 */
export function _resetProjectPromptOverridesForTests(): void {
  cachedByKey.clear()
  inFlightByKey.clear()
}
