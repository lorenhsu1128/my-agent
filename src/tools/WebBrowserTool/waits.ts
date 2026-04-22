/**
 * Wait primitives for WebBrowserTool.
 *
 * 設計原則：
 *   - 所有原語統一回傳 `{ waited: boolean; strategy: string; elapsedMs: number }`
 *   - 超時不 throw，回 `waited: false` 讓上層 action 決定要不要重試 / 繼續
 *   - 預設 timeout 10s，action 內部 best-effort settle 用短 timeout（2-3s）
 *
 * 用途：navigate / click / type / press / scroll / back 等動作完成後，
 * 頁面可能還在跑 async JS（SPA 路由、懶載入、tile 載入），立即 snapshot
 * 會抓到半成品。settle 給頁面幾秒安靜期；顯式 wait_for 則讓 LLM 自己指定
 * 停等條件（selector / function / url 變化）。
 */
import type { Page } from 'puppeteer-core'

export interface WaitResult {
  waited: boolean
  strategy: string
  elapsedMs: number
  error?: string
}

export interface SettleOptions {
  /** Network-idle 判定的連續安靜 ms（puppeteer 預設 500）。 */
  idleTimeMs?: number
  /** 總超時。 */
  timeoutMs?: number
}

/**
 * 綜合 settle：先試 networkIdle，失敗時 fallback 到靜默 DOM mutation 觀察。
 * 任一方達標即視為 settle。
 */
export async function waitForSettle(
  page: Page,
  opts: SettleOptions = {},
): Promise<WaitResult> {
  const idleTime = opts.idleTimeMs ?? 500
  const timeout = opts.timeoutMs ?? 10_000
  const start = Date.now()

  // Race: networkIdle vs quietDomMutation — 先到的贏
  const networkIdle = page
    .waitForNetworkIdle({ idleTime, timeout })
    .then(() => 'network-idle')
    .catch((e: Error) => {
      throw e
    })

  const quietDom = quietDomMutation(page, { quietMs: idleTime, timeoutMs: timeout })
    .then(r => (r.waited ? 'quiet-dom' : Promise.reject(new Error('dom-not-quiet'))))
    .catch((e: Error) => {
      throw e
    })

  try {
    const strategy = await Promise.any([networkIdle, quietDom])
    return {
      waited: true,
      strategy,
      elapsedMs: Date.now() - start,
    }
  } catch (err) {
    return {
      waited: false,
      strategy: 'none',
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface WaitForSelectorOptions {
  state?: 'visible' | 'hidden' | 'attached'
  timeoutMs?: number
}

export async function waitForSelector(
  page: Page,
  selector: string,
  opts: WaitForSelectorOptions = {},
): Promise<WaitResult> {
  const timeout = opts.timeoutMs ?? 10_000
  const state = opts.state ?? 'visible'
  const start = Date.now()
  try {
    await page.waitForSelector(selector, {
      visible: state === 'visible',
      hidden: state === 'hidden',
      timeout,
    })
    return {
      waited: true,
      strategy: `selector:${state}`,
      elapsedMs: Date.now() - start,
    }
  } catch (err) {
    return {
      waited: false,
      strategy: `selector:${state}`,
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface WaitForFunctionOptions {
  timeoutMs?: number
  /** 輪詢間隔 ms（或 'raf'）；預設由 puppeteer 處理。 */
  pollingMs?: number
}

/**
 * 等 `expression`（字串 JS，page context 內 eval）回 truthy。
 * 例：`() => !!window.google?.maps`。
 */
export async function waitForFunction(
  page: Page,
  expression: string,
  opts: WaitForFunctionOptions = {},
): Promise<WaitResult> {
  const timeout = opts.timeoutMs ?? 10_000
  const start = Date.now()
  try {
    await page.waitForFunction(expression, {
      timeout,
      polling: opts.pollingMs ?? undefined,
    })
    return {
      waited: true,
      strategy: 'function',
      elapsedMs: Date.now() - start,
    }
  } catch (err) {
    return {
      waited: false,
      strategy: 'function',
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface WaitForUrlOptions {
  timeoutMs?: number
}

/**
 * 等 URL 變成符合 pattern（regex 字串）。用於 SPA 路由切換等待。
 */
export async function waitForUrlChange(
  page: Page,
  pattern: string,
  opts: WaitForUrlOptions = {},
): Promise<WaitResult> {
  const timeout = opts.timeoutMs ?? 10_000
  const start = Date.now()
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch {
    return {
      waited: false,
      strategy: 'url',
      elapsedMs: 0,
      error: `Invalid regex: ${pattern}`,
    }
  }
  try {
    // 在 page context 裡丟 RegExp source 回去比對；waitForFunction 會輪詢
    await page.waitForFunction(
      (src: string, flags: string) => new RegExp(src, flags).test(location.href),
      { timeout },
      re.source,
      re.flags,
    )
    return {
      waited: true,
      strategy: 'url',
      elapsedMs: Date.now() - start,
    }
  } catch (err) {
    return {
      waited: false,
      strategy: 'url',
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface QuietDomMutationOptions {
  /** 連續無 mutation 超過這段時間即視為靜默。 */
  quietMs?: number
  timeoutMs?: number
}

/**
 * 注入 MutationObserver，等 body 子樹連續 quietMs 無變動。
 * 用在 networkIdle 不適用的場景（例如 long-poll / streaming fetch 讓 network
 * 永不 idle，但 DOM 已經穩）。
 */
export async function quietDomMutation(
  page: Page,
  opts: QuietDomMutationOptions = {},
): Promise<WaitResult> {
  const quietMs = opts.quietMs ?? 500
  const timeout = opts.timeoutMs ?? 10_000
  const start = Date.now()
  try {
    await page.evaluate(
      (quiet: number, total: number) =>
        new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + total
          let lastMutation = Date.now()
          const mo = new MutationObserver(() => {
            lastMutation = Date.now()
          })
          mo.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          })
          const tick = (): void => {
            const now = Date.now()
            if (now - lastMutation >= quiet) {
              mo.disconnect()
              resolve()
              return
            }
            if (now >= deadline) {
              mo.disconnect()
              reject(new Error('quiet-dom timeout'))
              return
            }
            setTimeout(tick, Math.min(quiet, 100))
          }
          setTimeout(tick, Math.min(quiet, 100))
        }),
      quietMs,
      timeout,
    )
    return {
      waited: true,
      strategy: 'quiet-dom',
      elapsedMs: Date.now() - start,
    }
  } catch (err) {
    return {
      waited: false,
      strategy: 'quiet-dom',
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// 統一 wait_for dispatcher（供 action schema 使用）
// ---------------------------------------------------------------------------

export interface WaitForInput {
  selector?: string
  state?: 'visible' | 'hidden' | 'attached'
  function?: string
  url_matches?: string
  timeout_ms?: number
}

export async function dispatchWaitFor(
  page: Page,
  wf: WaitForInput | undefined,
): Promise<WaitResult | null> {
  if (!wf) return null
  const timeoutMs = wf.timeout_ms ?? 10_000
  if (wf.selector) {
    return waitForSelector(page, wf.selector, { state: wf.state, timeoutMs })
  }
  if (wf.function) {
    return waitForFunction(page, wf.function, { timeoutMs })
  }
  if (wf.url_matches) {
    return waitForUrlChange(page, wf.url_matches, { timeoutMs })
  }
  return null
}
