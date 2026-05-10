/**
 * System Prompt Externalization — Per-cwd 啟動凍結快照
 *
 * 模式沿用 src/userModel/userModel.ts，但快取是 per-project（依 cwd 算 slug）：
 *   - loadSystemPromptSnapshot(cwd?) session 首次呼叫該 cwd 時讀所有 externalized
 *     sections 並凍結；同 cwd 重複呼叫會 de-dup。
 *   - getSection(id, cwd?) 同步回傳該 cwd 凍結結果，供 prompts.ts 內同步的
 *     getXxxSection() 使用。
 *   - _resetSystemPromptSnapshotForTests() 清整個 Map。
 *
 * 為什麼 per-cwd（M-SP-FULL Phase 1）：
 *   舊版本是 module-level singleton，daemon 模式下多個 project（不同 cwd）會
 *   共用同一份 snapshot，per-project section 檔案永遠不會被讀。改成 per-cwd
 *   Map 後，daemon bootstrap 每個 project 時各自載自己的 snapshot。
 *
 *   無 cwd（key = DEFAULT_KEY）保留給 REPL / 啟動期 setup.ts 用，行為與舊版
 *   一致（用 process-level getProjectRoot 算路徑）。
 */
import { SECTIONS, type SectionId } from './sections.js'
import { loadSystemPromptSection } from './loader.js'
import { getProjectSlugForCwd } from './paths.js'

export interface SystemPromptSnapshot {
  sections: Partial<Record<SectionId, string>>
}

const EMPTY_SNAPSHOT: SystemPromptSnapshot = { sections: {} }

/**
 * 「無 cwd」對應的 key（REPL / 啟動 setup 路徑用）。Slug 算出來不會撞到任何
 * 真實 project（sanitizePath 不會產出 `__default__`）。
 */
const DEFAULT_KEY = '__default__'

const cachedByKey = new Map<string, SystemPromptSnapshot>()
const inFlightByKey = new Map<string, Promise<SystemPromptSnapshot>>()

function keyForCwd(cwd?: string): string {
  return cwd ? getProjectSlugForCwd(cwd) : DEFAULT_KEY
}

async function readLive(cwd: string | undefined): Promise<SystemPromptSnapshot> {
  const entries = await Promise.all(
    SECTIONS.filter(s => s.externalized).map(
      async s => [s.id, await loadSystemPromptSection(s.id, cwd)] as const,
    ),
  )
  const sections: Partial<Record<SectionId, string>> = {}
  for (const [id, content] of entries) {
    if (content !== null) sections[id] = content
  }
  return { sections }
}

/**
 * Daemon 每個 project bootstrap / REPL session 啟動時呼叫，讀一次並凍結。
 * 同 cwd 重複呼叫會 de-dup（同時多路啟動共用 in-flight Promise）。
 *
 * @param cwd  daemon multi-project 場景傳該 project 的 cwd；REPL / 啟動 setup 不傳。
 */
export async function loadSystemPromptSnapshot(
  cwd?: string,
): Promise<SystemPromptSnapshot> {
  const key = keyForCwd(cwd)
  const cached = cachedByKey.get(key)
  if (cached) return cached
  const inFlight = inFlightByKey.get(key)
  if (inFlight) return inFlight
  const promise = readLive(cwd).then(snap => {
    cachedByKey.set(key, snap)
    inFlightByKey.delete(key)
    return snap
  })
  inFlightByKey.set(key, promise)
  return promise
}

/**
 * 取得已凍結的快照。尚未載入則回傳空快照——呼叫端應確保 bootstrap 已觸發
 * loadSystemPromptSnapshot(cwd)。
 */
export function getSystemPromptSnapshot(
  cwd?: string,
): SystemPromptSnapshot {
  return cachedByKey.get(keyForCwd(cwd)) ?? EMPTY_SNAPSHOT
}

/**
 * 同步取某個 section 的內容。未在 snapshot 裡回 null，呼叫端走 bundled/
 * 原始邏輯 fallback。
 *
 * @param cwd  daemon 路徑必傳；REPL / setup 路徑不傳，會走 DEFAULT_KEY snapshot。
 */
export function getSection(id: SectionId, cwd?: string): string | null {
  const snap = getSystemPromptSnapshot(cwd)
  return snap.sections[id] ?? null
}

/**
 * 簡易 `{var}` 插值：白名單變數 map，找不到的 key 維持原樣。
 * 僅用於 section 內少量明確佔位（如 {TICK_TAG} / {SLEEP_TOOL_NAME} /
 * {scratchpadDir} / {keepRecent} / errors 的 {maxTurns} 等）；不做複雜 template 解析。
 */
export function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    return key in vars ? String(vars[key]) : match
  })
}

/**
 * 組合「讀 section + 插值」的便捷方法。snapshot 缺檔 → 回 null（呼叫端 fallback）。
 */
export function getSectionInterpolated(
  id: SectionId,
  vars: Record<string, string | number>,
  cwd?: string,
): string | null {
  const raw = getSection(id, cwd)
  if (raw === null) return null
  return interpolate(raw, vars)
}

/** 測試用：清除所有 cwd 的快取與 in-flight Promise。 */
export function _resetSystemPromptSnapshotForTests(): void {
  cachedByKey.clear()
  inFlightByKey.clear()
}
