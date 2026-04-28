/**
 * M-LLAMACPP-WATCHDOG：客戶端三層 watchdog 純函式實作。
 *
 * 預期消費者：`createLlamaCppFetch`（src/services/api/llamacpp-fetch-adapter.ts）
 * 在 fetch 拿到 SSE response 後把 stream 透過此模組包裝再交給上層。
 *
 * 三層偵測：
 *   A. interChunk：兩個 SSE chunk 之間最大允許靜默間隔（gapMs）
 *   B. reasoning：開始 emit `reasoning_content` 後 N ms 沒見到 `</think>` / 切回 content
 *   C. tokenCap：累積 token（reasoning + content）超 ceiling[callSite]
 *
 * 任何一層觸發 → AbortController.abort(error: WatchdogAbortError) → 上層 fetch
 * 中斷 → HTTP connection close → llama.cpp server 偵測 client gone → slot 自動釋放。
 *
 * 設計：純函式 + 不直接讀檔 / 環境變數，config 由呼叫端注入；單元測試友善。
 */

import type {
  LlamaCppCallSite,
  LlamaCppWatchdogConfig,
} from '../../llamacppConfig/schema.js'

export type WatchdogLayer = 'interChunk' | 'reasoning' | 'tokenCap'

/** Watchdog 觸發後的 error 物件，caller 可從訊息辨識哪層觸發。 */
export class WatchdogAbortError extends Error {
  readonly layer: WatchdogLayer
  readonly stats: { tokens: number; elapsedMs: number; callSite: LlamaCppCallSite }
  constructor(
    layer: WatchdogLayer,
    message: string,
    stats: { tokens: number; elapsedMs: number; callSite: LlamaCppCallSite },
  ) {
    super(`llamacpp-watchdog[${layer}]: ${message}`)
    this.name = 'WatchdogAbortError'
    this.layer = layer
    this.stats = stats
  }
}

/**
 * 判斷某層是否「實際生效」（master AND 該層 enabled）。
 * 任一 false 等於該層不存在。
 */
export function layerActive(
  cfg: LlamaCppWatchdogConfig,
  layer: WatchdogLayer,
): boolean {
  if (!cfg.enabled) return false
  if (layer === 'interChunk') return cfg.interChunk.enabled
  if (layer === 'reasoning') return cfg.reasoning.enabled
  return cfg.tokenCap.enabled
}

/** 取得 token cap 上限（依 callSite）— 若 layer 未啟用回 Infinity（無限制）。 */
export function getTokenCap(
  cfg: LlamaCppWatchdogConfig,
  callSite: LlamaCppCallSite,
): number {
  if (!layerActive(cfg, 'tokenCap')) return Number.POSITIVE_INFINITY
  switch (callSite) {
    case 'memoryPrefetch':
      return cfg.tokenCap.memoryPrefetch
    case 'sideQuery':
      return cfg.tokenCap.sideQuery
    case 'background':
      return cfg.tokenCap.background
    case 'vision':
      // M-LLAMACPP-REMOTE: vision 走 background-tier cap（與 cron / extractMemories 同級）；
      // 真要更高請另設 watchdog.tokenCap.vision 並補 schema 欄位。
      return cfg.tokenCap.background
    case 'turn':
    default:
      return cfg.tokenCap.default
  }
}

/** 從一個 OpenAI SSE chunk 估算這 chunk 帶了多少 token（粗估：char count / 3）。 */
export function estimateChunkTokens(payload: string): number {
  // 粗估：簡單以 reasoning_content + content 字元長度 / 3
  // 不解析整個 JSON 也不依賴 server 真實 tokenizer；保守一點。
  const reMatch = payload.match(/"reasoning_content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const ctMatch = payload.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const reLen = reMatch ? reMatch[1]!.length : 0
  const ctLen = ctMatch ? ctMatch[1]!.length : 0
  return Math.ceil((reLen + ctLen) / 3)
}

/** 偵測 chunk 是否在 reasoning 區（含非空 reasoning_content）。 */
export function chunkIsReasoning(payload: string): boolean {
  return /"reasoning_content"\s*:\s*"[^"]/.test(payload)
}

/** 偵測 chunk 是否切回 content 區（reasoning_content 結束、content 出現非空字串）。 */
export function chunkIsContent(payload: string): boolean {
  return /"content"\s*:\s*"[^"]/.test(payload)
}

/**
 * Watchdog state — caller 在 stream loop 內呼叫 `tickChunk()` 推進，每次回傳
 * 是否該 abort + 觸發層次。State machine 清楚不藏 timer。
 */
export interface WatchdogState {
  startMs: number
  lastChunkMs: number
  reasoningStartMs: number | null
  totalTokens: number
}

export function createWatchdogState(): WatchdogState {
  const now = Date.now()
  return {
    startMs: now,
    lastChunkMs: now,
    reasoningStartMs: null,
    totalTokens: 0,
  }
}

export type TickResult =
  | { abort: false }
  | { abort: true; layer: WatchdogLayer; reason: string }

/**
 * 推進 watchdog state；caller 對每個 SSE chunk payload 呼叫一次。
 * 也可只用「時間到了 check」呼叫（傳 `null` payload，僅檢查 timer）。
 */
export function tickChunk(
  state: WatchdogState,
  payload: string | null,
  cfg: LlamaCppWatchdogConfig,
  callSite: LlamaCppCallSite,
  nowMs: number = Date.now(),
): TickResult {
  // ----- 時間 check（無 payload 也跑） -----
  if (layerActive(cfg, 'interChunk')) {
    const gap = nowMs - state.lastChunkMs
    if (gap > cfg.interChunk.gapMs) {
      return {
        abort: true,
        layer: 'interChunk',
        reason: `inter-chunk gap ${gap}ms > ${cfg.interChunk.gapMs}ms`,
      }
    }
  }
  if (layerActive(cfg, 'reasoning') && state.reasoningStartMs !== null) {
    const inThinking = nowMs - state.reasoningStartMs
    if (inThinking > cfg.reasoning.blockMs) {
      return {
        abort: true,
        layer: 'reasoning',
        reason: `reasoning block ${inThinking}ms > ${cfg.reasoning.blockMs}ms without </think>`,
      }
    }
  }
  if (payload === null) return { abort: false }

  // ----- payload 推進 state -----
  state.lastChunkMs = nowMs
  state.totalTokens += estimateChunkTokens(payload)

  if (chunkIsReasoning(payload) && state.reasoningStartMs === null) {
    state.reasoningStartMs = nowMs
  }
  // 切回 content 視為 reasoning 結束（即使 server 不一定 emit 顯式 `</think>`）
  if (chunkIsContent(payload) && state.reasoningStartMs !== null) {
    state.reasoningStartMs = null
  }

  if (layerActive(cfg, 'tokenCap')) {
    const cap = getTokenCap(cfg, callSite)
    if (state.totalTokens > cap) {
      return {
        abort: true,
        layer: 'tokenCap',
        reason: `accumulated ${state.totalTokens} tokens > ceiling ${cap} (callSite=${callSite})`,
      }
    }
  }
  return { abort: false }
}

/**
 * 把 SSE iterator 包成 watchdog 監控版本。
 *
 * - 每 chunk 過 `tickChunk()`；觸發 abort → 透過 controller.abort() 通知 fetch
 *   斷連；同時 throw `WatchdogAbortError` 讓上層 stream loop 知道並把 error 包
 *   成 Anthropic-shape 拋給 caller
 * - 設一個低頻 watchdog timer（每 5s 一次），即使 SSE 卡住沒新 chunk 也能觸發
 *   inter-chunk / reasoning 偵測（payload=null 模式）
 *
 * 純功能 — 不引入 Promise 包裝、不直接 console.log；caller 包裝記錄。
 */
export async function* watchSseStream(
  source: AsyncIterable<string>,
  cfg: LlamaCppWatchdogConfig,
  callSite: LlamaCppCallSite,
  controller: AbortController,
): AsyncGenerator<string, void, unknown> {
  // master off → 直接 passthrough，不裝任何 timer
  if (!cfg.enabled) {
    for await (const chunk of source) yield chunk
    return
  }

  const state = createWatchdogState()

  // 低頻 watchdog timer（每 5s 一次）— 模型卡 silent 時也能觸發
  let killed: { layer: WatchdogLayer; reason: string } | null = null
  const interval = setInterval(() => {
    const r = tickChunk(state, null, cfg, callSite)
    if (r.abort && !killed) {
      killed = { layer: r.layer, reason: r.reason }
      try {
        controller.abort(
          new WatchdogAbortError(r.layer, r.reason, {
            tokens: state.totalTokens,
            elapsedMs: Date.now() - state.startMs,
            callSite,
          }),
        )
      } catch {
        // 重複 abort 容忍
      }
    }
  }, 5_000)

  try {
    for await (const chunk of source) {
      if (killed) {
        throw new WatchdogAbortError(killed.layer, killed.reason, {
          tokens: state.totalTokens,
          elapsedMs: Date.now() - state.startMs,
          callSite,
        })
      }
      const r = tickChunk(state, chunk, cfg, callSite)
      if (r.abort) {
        try {
          controller.abort(
            new WatchdogAbortError(r.layer, r.reason, {
              tokens: state.totalTokens,
              elapsedMs: Date.now() - state.startMs,
              callSite,
            }),
          )
        } catch {
          // ignore
        }
        throw new WatchdogAbortError(r.layer, r.reason, {
          tokens: state.totalTokens,
          elapsedMs: Date.now() - state.startMs,
          callSite,
        })
      }
      yield chunk
    }
  } finally {
    clearInterval(interval)
  }
}
