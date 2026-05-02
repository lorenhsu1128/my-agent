// M-MEMRECALL-CMD：MemoryRecallManager 的純函式邏輯，抽出讓單元測試不用 Ink harness。

import type { RecallLogEntry } from '../../memdir/sessionRecallLog.js'

export type RecallMode =
  | 'list'
  | 'settings'
  | 'detail'
  | 'viewer'
  | 'rename'
  | 'confirmDelete'
  | 'wizard-edit'
  | 'test-input'
  | 'test-result'

export type SettingsField = 'enabled' | 'maxFiles' | 'fallbackMaxFiles'

export const SETTINGS_FIELDS: ReadonlyArray<SettingsField> = [
  'enabled',
  'maxFiles',
  'fallbackMaxFiles',
] as const

export const NUMBER_RANGE = { min: 1, max: 20 } as const

/** 把 number 限制在 1..20 區間。非有限數字 → fallback。 */
export function clampRange(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(NUMBER_RANGE.min, Math.min(NUMBER_RANGE.max, Math.round(n)))
}

/** 在 SETTINGS_FIELDS 內向下/向上切欄（環狀）。 */
export function nextField(current: SettingsField): SettingsField {
  const i = SETTINGS_FIELDS.indexOf(current)
  return SETTINGS_FIELDS[(i + 1) % SETTINGS_FIELDS.length]
}

export function prevField(current: SettingsField): SettingsField {
  const i = SETTINGS_FIELDS.indexOf(current)
  return SETTINGS_FIELDS[
    (i - 1 + SETTINGS_FIELDS.length) % SETTINGS_FIELDS.length
  ]
}

/** Filter recall history by keyword（filename 不分大小寫）；空字串回原列。 */
export function filterRecall(
  entries: ReadonlyArray<RecallLogEntry>,
  keyword: string,
): RecallLogEntry[] {
  const k = keyword.trim().toLowerCase()
  if (k.length === 0) return [...entries]
  return entries.filter(e => basename(e.path).toLowerCase().includes(k))
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

/** 把 epoch ms 渲染成 HH:MM 給 list 顯示用。 */
export function formatHHMM(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** 給 list row 渲染：basename + 命中數 + 時刻。 */
export function formatRow(entry: RecallLogEntry, maxName = 50): string {
  const name = basename(entry.path)
  const trimmed = name.length > maxName ? name.slice(0, maxName - 1) + '…' : name
  const padded = trimmed.padEnd(maxName, ' ')
  const src = entry.source === 'fallback' ? ' (fallback)' : ''
  return `${padded}  ${entry.hitCount}×  ${formatHHMM(entry.ts)}${src}`
}
