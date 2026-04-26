// M-LLAMACPP-WATCHDOG Phase 3-2：將 watchdog 設定寫回 ~/.my-agent/llamacpp.json
// + 提供 session-only override 機制（in-memory，不寫檔）。

import { existsSync, readFileSync } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { getLlamaCppConfigPath } from '../../llamacppConfig/paths.js'
import {
  getLlamaCppConfigSnapshot,
  _resetLlamaCppConfigForTests,
} from '../../llamacppConfig/loader.js'
import {
  LlamaCppConfigSchema,
  type LlamaCppWatchdogConfig,
  type LlamaCppConfig,
} from '../../llamacppConfig/schema.js'
import { writeJsoncPreservingComments } from '../../utils/jsoncStore.js'

export type MutationResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

// ---------------- session override ----------------

/**
 * Session-only watchdog 覆寫 — 不寫檔，行程內生效。`getEffectiveWatchdogConfig`
 * 不直接讀此值（它讀 file snapshot）；caller 想 query session override 自己呼叫
 * `getSessionWatchdogOverride()`。本 milestone Phase 3 預設 caller 會把 session
 * override 寫到 in-memory + 同時讓 adapter 在 fetch 前優先看 override。
 *
 * 簡化 MVP：本檔只提供 set/get，adapter 接通在後續 commit。
 */
let sessionWatchdogOverride: LlamaCppWatchdogConfig | null = null

export function setSessionWatchdogOverride(
  cfg: LlamaCppWatchdogConfig | null,
): void {
  sessionWatchdogOverride = cfg
}

export function getSessionWatchdogOverride(): LlamaCppWatchdogConfig | null {
  return sessionWatchdogOverride
}

// ---------------- 寫檔 ----------------

/** 取得當前完整 config（snapshot 為主，session override 不參與寫檔） */
function readCurrentConfig(): LlamaCppConfig {
  return getLlamaCppConfigSnapshot()
}

/**
 * 把 watchdog mutation 寫回 llamacpp.json。
 * - 透過 `writeJsoncPreservingComments` 保留註解 + atomic
 * - 寫完 reset loader cache 讓下次 `getLlamaCppConfigSnapshot()` 重讀
 * - daemon broadcast / hot-reload 由 caller 處理（本 helper 純 IO）
 */
export async function writeWatchdogConfig(
  newWatchdog: LlamaCppWatchdogConfig,
): Promise<MutationResult> {
  try {
    const path = getLlamaCppConfigPath()
    let originalText = ''
    if (existsSync(path)) {
      originalText = readFileSync(path, 'utf-8')
    }
    const parsedOld = originalText
      ? LlamaCppConfigSchema.safeParse(safeParseJsonc(originalText))
      : null
    const oldCfg =
      parsedOld?.success ? parsedOld.data : readCurrentConfig()
    const newCfg: LlamaCppConfig = { ...oldCfg, watchdog: newWatchdog }

    if (!originalText) {
      // 檔案不存在 → 直接 atomic write（沒註解可保留）
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(newCfg, null, 2) + '\n', 'utf-8')
    } else {
      await writeJsoncPreservingComments(path, originalText, newCfg)
    }

    // 強制 loader 下次重讀
    _resetLlamaCppConfigForTests()
    return { ok: true, message: `寫入 ${path}` }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function safeParseJsonc(raw: string): unknown {
  try {
    // jsoncStore.parseJsonc 可能 throw — 這裡寬鬆處理（出錯時用 schema fallback）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseJsonc } = require('../../utils/jsoncStore.js') as typeof import('../../utils/jsoncStore.js')
    return parseJsonc(raw)
  } catch {
    return {}
  }
}

// ---------------- slots kill（呼叫 server 端 cancel） ----------------

/**
 * 對 llama.cpp server 送 `POST /slots/<id>?action=erase` cancel slot。
 * 需 server 啟動時帶 `--slot-save-path`，否則回 501。
 */
export async function killSlot(
  slotId: number,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  try {
    const cfg = getLlamaCppConfigSnapshot()
    // baseUrl 通常結尾 /v1，slots endpoint 不在 v1 namespace
    const root = cfg.baseUrl.replace(/\/v1\/?$/, '')
    const url = `${root}/slots/${slotId}?action=erase`
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const res = await globalThis.fetch(url, { method: 'POST' })
    if (res.ok) return { ok: true }
    const txt = await res.text()
    return {
      ok: false,
      error: `${res.status}: ${txt.slice(0, 200)}`,
      status: res.status,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------- /v1/slots 讀取 ----------------

export type SlotInfo = {
  id: number
  isProcessing: boolean
  nDecoded: number
  nRemain: number
  hasNextToken: boolean
}

export async function fetchSlots(): Promise<
  { ok: true; slots: SlotInfo[] } | { ok: false; error: string }
> {
  try {
    const cfg = getLlamaCppConfigSnapshot()
    const root = cfg.baseUrl.replace(/\/v1\/?$/, '')
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const res = await globalThis.fetch(`${root}/slots`)
    if (!res.ok) return { ok: false, error: `${res.status}: ${res.statusText}` }
    const arr = (await res.json()) as Array<{
      id: number
      is_processing: boolean
      next_token: Array<{
        n_decoded: number
        n_remain: number
        has_next_token: boolean
      }>
    }>
    const slots: SlotInfo[] = arr.map(s => ({
      id: s.id,
      isProcessing: s.is_processing,
      nDecoded: s.next_token?.[0]?.n_decoded ?? 0,
      nRemain: s.next_token?.[0]?.n_remain ?? 0,
      hasNextToken: s.next_token?.[0]?.has_next_token ?? false,
    }))
    return { ok: true, slots }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
