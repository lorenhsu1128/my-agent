// M-LLAMACPP-WATCHDOG Phase 3-1：LlamacppManager 純函式邏輯。

import type {
  LlamaCppCallSite,
  LlamaCppWatchdogConfig,
} from '../../llamacppConfig/schema.js'

export type TabId = 'watchdog' | 'slots' | 'endpoints'

export type TabSpec = {
  id: TabId
  label: string
}

export const TABS: ReadonlyArray<TabSpec> = [
  { id: 'watchdog', label: 'Watchdog' },
  { id: 'slots', label: 'Slots' },
  { id: 'endpoints', label: 'Endpoints' },
]

export function nextTab(current: TabId): TabId {
  const idx = TABS.findIndex(t => t.id === current)
  return TABS[(idx + 1) % TABS.length]!.id
}

export function prevTab(current: TabId): TabId {
  const idx = TABS.findIndex(t => t.id === current)
  return TABS[(idx - 1 + TABS.length) % TABS.length]!.id
}

// ---- Watchdog tab field model ----

export type WatchdogFieldId =
  | 'master.enabled'
  | 'interChunk.enabled'
  | 'interChunk.gapMs'
  | 'reasoning.enabled'
  | 'reasoning.blockMs'
  | 'tokenCap.enabled'
  | 'tokenCap.default'
  | 'tokenCap.memoryPrefetch'
  | 'tokenCap.sideQuery'
  | 'tokenCap.background'

export type WatchdogFieldKind = 'toggle' | 'number'

export type WatchdogFieldSpec = {
  id: WatchdogFieldId
  label: string
  kind: WatchdogFieldKind
  /** Toggle 用，從 cfg 讀 */
  getBool?: (c: LlamaCppWatchdogConfig) => boolean
  /** Number 用 */
  getNumber?: (c: LlamaCppWatchdogConfig) => number
  /** 設值（純函式：回新 cfg） */
  setBool?: (c: LlamaCppWatchdogConfig, v: boolean) => LlamaCppWatchdogConfig
  setNumber?: (c: LlamaCppWatchdogConfig, v: number) => LlamaCppWatchdogConfig
}

export const WATCHDOG_FIELDS: ReadonlyArray<WatchdogFieldSpec> = [
  {
    id: 'master.enabled',
    label: 'Master enabled',
    kind: 'toggle',
    getBool: c => c.enabled,
    setBool: (c, v) => ({ ...c, enabled: v }),
  },
  {
    id: 'interChunk.enabled',
    label: 'A. Inter-chunk gap',
    kind: 'toggle',
    getBool: c => c.interChunk.enabled,
    setBool: (c, v) => ({ ...c, interChunk: { ...c.interChunk, enabled: v } }),
  },
  {
    id: 'interChunk.gapMs',
    label: '   gapMs',
    kind: 'number',
    getNumber: c => c.interChunk.gapMs,
    setNumber: (c, v) => ({ ...c, interChunk: { ...c.interChunk, gapMs: v } }),
  },
  {
    id: 'reasoning.enabled',
    label: 'B. Reasoning-block',
    kind: 'toggle',
    getBool: c => c.reasoning.enabled,
    setBool: (c, v) => ({ ...c, reasoning: { ...c.reasoning, enabled: v } }),
  },
  {
    id: 'reasoning.blockMs',
    label: '   blockMs',
    kind: 'number',
    getNumber: c => c.reasoning.blockMs,
    setNumber: (c, v) => ({ ...c, reasoning: { ...c.reasoning, blockMs: v } }),
  },
  {
    id: 'tokenCap.enabled',
    label: 'C. Token cap',
    kind: 'toggle',
    getBool: c => c.tokenCap.enabled,
    setBool: (c, v) => ({ ...c, tokenCap: { ...c.tokenCap, enabled: v } }),
  },
  {
    id: 'tokenCap.default',
    label: '   default (turn)',
    kind: 'number',
    getNumber: c => c.tokenCap.default,
    setNumber: (c, v) => ({ ...c, tokenCap: { ...c.tokenCap, default: v } }),
  },
  {
    id: 'tokenCap.memoryPrefetch',
    label: '   memoryPrefetch',
    kind: 'number',
    getNumber: c => c.tokenCap.memoryPrefetch,
    setNumber: (c, v) => ({
      ...c,
      tokenCap: { ...c.tokenCap, memoryPrefetch: v },
    }),
  },
  {
    id: 'tokenCap.sideQuery',
    label: '   sideQuery',
    kind: 'number',
    getNumber: c => c.tokenCap.sideQuery,
    setNumber: (c, v) => ({ ...c, tokenCap: { ...c.tokenCap, sideQuery: v } }),
  },
  {
    id: 'tokenCap.background',
    label: '   background',
    kind: 'number',
    getNumber: c => c.tokenCap.background,
    setNumber: (c, v) => ({
      ...c,
      tokenCap: { ...c.tokenCap, background: v },
    }),
  },
]

export function getFieldSpec(id: WatchdogFieldId): WatchdogFieldSpec {
  const f = WATCHDOG_FIELDS.find(x => x.id === id)
  if (!f) throw new Error(`unknown watchdog field: ${id}`)
  return f
}

// ---- bulk operations ----

export const DEFAULT_WATCHDOG_CONFIG: LlamaCppWatchdogConfig = {
  enabled: false,
  interChunk: { enabled: false, gapMs: 30_000 },
  reasoning: { enabled: false, blockMs: 120_000 },
  tokenCap: {
    enabled: false,
    default: 16_000,
    memoryPrefetch: 256,
    sideQuery: 1_024,
    background: 4_000,
  },
}

/** all on：master + 三層 enabled 全 true，數值不動 */
export function turnAllOn(c: LlamaCppWatchdogConfig): LlamaCppWatchdogConfig {
  return {
    ...c,
    enabled: true,
    interChunk: { ...c.interChunk, enabled: true },
    reasoning: { ...c.reasoning, enabled: true },
    tokenCap: { ...c.tokenCap, enabled: true },
  }
}

/** all off：master + 三層 enabled 全 false，數值不動 */
export function turnAllOff(c: LlamaCppWatchdogConfig): LlamaCppWatchdogConfig {
  return {
    ...c,
    enabled: false,
    interChunk: { ...c.interChunk, enabled: false },
    reasoning: { ...c.reasoning, enabled: false },
    tokenCap: { ...c.tokenCap, enabled: false },
  }
}

/** reset：回 DEFAULT_WATCHDOG_CONFIG（all off + 預設數值） */
export function resetWatchdog(): LlamaCppWatchdogConfig {
  return DEFAULT_WATCHDOG_CONFIG
}

// ---- 簡易短碼 → call-site 對應（用於 args parser `C.background` 等） ----

export function parseCallSiteSuffix(
  raw: string,
): LlamaCppCallSite | 'default' | null {
  const m = raw.toLowerCase()
  if (m === 'default' || m === 'turn') return 'turn'
  if (m === 'memoryprefetch') return 'memoryPrefetch'
  if (m === 'sidequery') return 'sideQuery'
  if (m === 'background') return 'background'
  return null
}

// ---- 顯示用 ----

export function formatMs(n: number): string {
  if (n < 1000) return `${n} ms`
  return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} s`
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `${n}`
}

/** 計算「該層實際生效嗎？」master + 該層 enabled AND */
export function isLayerEffective(
  c: LlamaCppWatchdogConfig,
  layer: 'interChunk' | 'reasoning' | 'tokenCap',
): boolean {
  if (!c.enabled) return false
  return c[layer].enabled
}
