/**
 * System Prompt Externalization — Session 啟動凍結快照
 *
 * 模式沿用 src/userModel/userModel.ts：
 *   - loadSnapshot() session 首次呼叫時讀所有 externalized sections 並凍結
 *   - getSnapshot() 同步回傳凍結結果，供 prompts.ts 內同步的 getXxxSection() 使用
 *   - _resetSnapshotForTests() 測試清除
 */
import { SECTIONS, type SectionId } from './sections.js'
import { loadSystemPromptSection } from './loader.js'

export interface SystemPromptSnapshot {
  sections: Partial<Record<SectionId, string>>
}

const EMPTY_SNAPSHOT: SystemPromptSnapshot = { sections: {} }

let cachedSnapshot: SystemPromptSnapshot | null = null
let loadInFlight: Promise<SystemPromptSnapshot> | null = null

async function readLive(): Promise<SystemPromptSnapshot> {
  const entries = await Promise.all(
    SECTIONS.filter(s => s.externalized).map(
      async s => [s.id, await loadSystemPromptSection(s.id)] as const,
    ),
  )
  const sections: Partial<Record<SectionId, string>> = {}
  for (const [id, content] of entries) {
    if (content !== null) sections[id] = content
  }
  return { sections }
}

/**
 * Session 啟動時呼叫，讀一次並凍結。重複呼叫會 de-dup（同時多路啟動時共用 Promise）。
 */
export async function loadSystemPromptSnapshot(): Promise<SystemPromptSnapshot> {
  if (cachedSnapshot) return cachedSnapshot
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(snap => {
    cachedSnapshot = snap
    loadInFlight = null
    return snap
  })
  return loadInFlight
}

/**
 * 取得已凍結的快照。尚未載入則回傳空快照——呼叫端應確保 bootstrap 已觸發 loadSystemPromptSnapshot。
 */
export function getSystemPromptSnapshot(): SystemPromptSnapshot {
  return cachedSnapshot ?? EMPTY_SNAPSHOT
}

/**
 * 同步取某個 section 的內容。未在 snapshot 裡回 null，呼叫端走 bundled/原始邏輯 fallback。
 */
export function getSection(id: SectionId): string | null {
  const snap = getSystemPromptSnapshot()
  return snap.sections[id] ?? null
}

/** 測試用：清除快取 */
export function _resetSystemPromptSnapshotForTests(): void {
  cachedSnapshot = null
  loadInFlight = null
}
