/**
 * Action handlers for WebBrowserTool (puppeteer-core backed).
 *
 * Security layers applied uniformly:
 *   - URL protocol + secret-exfil check (urlContainsSecret)
 *   - Website blocklist (checkBlocklist)
 *   - DNS-level SSRF rejection (isBlockedAddress)
 *   - Secret redaction on every text returned to the model (redactSecrets)
 *
 * Wait model（2026-04-22 重構）：
 *   - 所有會改頁面狀態的動作（navigate/click/type/press/scroll/back/
 *     click_at/mouse_drag/wheel）動作後做 best-effort settle（2-3s），
 *     回傳 `settle` 欄位讓 LLM 知道有沒有等到安靜
 *   - 任何動作可額外傳 `wait_for`（selector / function / url_matches），
 *     在 settle 之後再跑，讓 LLM 精準等待
 */
import { lookup as dnsLookup } from 'dns'
import type { ConsoleMessage } from 'puppeteer-core'
import { isBlockedAddress } from '../../utils/hooks/ssrfGuard.js'
import { checkBlocklist } from '../../utils/web/blocklist.js'
import { redactSecrets, urlContainsSecret } from '../../utils/web/secretScan.js'
import { getDefaultVisionClient } from '../../utils/vision/VisionClient.js'
import { refToElement, takeSnapshot } from './a11y.js'
import { closeSession, getSession } from './session.js'
import {
  dispatchWaitFor,
  waitForSettle,
  type WaitForInput,
  type WaitResult,
} from './waits.js'

async function resolveHost(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses.map(a => a.address))
    })
  })
}

async function assertUrlSafe(urlStr: string): Promise<void> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) supported, got: ${url.protocol}`)
  }
  if (urlContainsSecret(urlStr)) {
    throw new Error(
      'URL contains what appears to be an API key or token; refusing to navigate.',
    )
  }
  const blocked = checkBlocklist(urlStr)
  if (blocked) throw new Error(blocked.message)

  try {
    const addrs = await resolveHost(url.hostname)
    for (const a of addrs) {
      if (isBlockedAddress(a)) {
        throw new Error(
          `Blocked: ${url.hostname} resolves to private/internal address ${a}`,
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Blocked:')) throw err
    // DNS failure — let puppeteer surface the real error on goto
  }
}

// ---------------------------------------------------------------------------
// Settle + wait_for helpers（動作共用）
// ---------------------------------------------------------------------------

async function settleAndWait(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  wf: WaitForInput | undefined,
  settleTimeoutMs = 2_000,
): Promise<{ settle: WaitResult; wait_for?: WaitResult }> {
  const settle = await waitForSettle(page, { timeoutMs: settleTimeoutMs })
  const wait_for = await dispatchWaitFor(page, wf)
  return wait_for ? { settle, wait_for } : { settle }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function navigate(
  url: string,
  waitFor?: WaitForInput,
): Promise<object> {
  await assertUrlSafe(url)
  const s = await getSession()
  const resp = await s.page.goto(url, {
    waitUntil: 'load',
    timeout: 30_000,
  })
  const finalUrl = s.page.url()
  if (finalUrl !== url) await assertUrlSafe(finalUrl)
  // navigate 後給頁面稍長的 settle window（3s）讓 async JS 起步
  const waits = await settleAndWait(s.page, waitFor, 3_000)
  return {
    url: finalUrl,
    status: resp?.status() ?? null,
    title: await s.page.title().catch(() => ''),
    ...waits,
  }
}

export async function snapshot(): Promise<object> {
  const s = await getSession()
  const snap = await takeSnapshot(s.page)
  s.refEntries = snap.refs
  s.snapshotGeneration = s.generation
  return {
    url: snap.url,
    title: snap.title,
    generation: s.generation,
    ref_count: snap.refs.size,
    summary: snap.summary,
    tree: redactSecrets(snap.text),
  }
}

export async function click(
  ref: string,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  const resolved = await refToElement(
    s.page,
    ref,
    s.refEntries,
    s.snapshotGeneration,
    s.generation,
  )
  if (resolved.handle) {
    await resolved.handle.click({ delay: 10 })
    await resolved.handle.dispose().catch(() => void 0)
  } else if (resolved.box) {
    const { x, y, width, height } = resolved.box
    await s.page.mouse.click(x + width / 2, y + height / 2, { delay: 10 })
  } else {
    // refToElement guarantees handle || box when no error, so this is defensive
    throw new Error(`click: no usable target for ref ${ref}`)
  }
  const waits = await settleAndWait(s.page, waitFor)
  return { ok: true, ref, strategy: resolved.strategy, ...waits }
}

export async function type_(
  ref: string,
  text: string,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  const resolved = await refToElement(
    s.page,
    ref,
    s.refEntries,
    s.snapshotGeneration,
    s.generation,
  )
  if (resolved.handle) {
    await resolved.handle.focus()
    await resolved.handle.evaluate(n => {
      if ('value' in n) (n as HTMLInputElement).value = ''
    })
    await resolved.handle.type(text)
    await resolved.handle.dispose().catch(() => void 0)
  } else if (resolved.box) {
    // Coordinate fallback: click to focus, then type via global keyboard.
    // Can't clear prior value without a handle — best effort: Ctrl+A + Delete
    // before typing so the field doesn't end up with "old text + new text".
    const { x, y, width, height } = resolved.box
    await s.page.mouse.click(x + width / 2, y + height / 2)
    await s.page.keyboard.down('Control')
    await s.page.keyboard.press('KeyA')
    await s.page.keyboard.up('Control')
    await s.page.keyboard.press('Delete')
    await s.page.keyboard.type(text)
  } else {
    throw new Error(`type: no usable target for ref ${ref}`)
  }
  const waits = await settleAndWait(s.page, waitFor)
  return {
    ok: true,
    ref,
    typed: text.length,
    strategy: resolved.strategy,
    ...waits,
  }
}

export async function scroll(
  direction: 'up' | 'down',
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  const dy = direction === 'down' ? 500 : -500
  await s.page.evaluate(d => window.scrollBy(0, d), dy)
  const waits = await settleAndWait(s.page, waitFor)
  return { ok: true, direction, ...waits }
}

export async function back(waitFor?: WaitForInput): Promise<object> {
  const s = await getSession()
  await s.page.goBack({ waitUntil: 'load' })
  const waits = await settleAndWait(s.page, waitFor, 3_000)
  return { ok: true, url: s.page.url(), ...waits }
}

export async function press(
  key: string,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  await s.page.keyboard.press(key as Parameters<typeof s.page.keyboard.press>[0])
  const waits = await settleAndWait(s.page, waitFor)
  return { ok: true, key, ...waits }
}

export async function consoleLogs(clear = false): Promise<object> {
  const s = await getSession()
  if (!s.consoleBuffer) {
    s.consoleBuffer = []
    s.page.on('console', (m: ConsoleMessage) => {
      s.consoleBuffer!.push(`[${m.type()}] ${redactSecrets(m.text())}`)
      if (s.consoleBuffer!.length > 500) s.consoleBuffer!.shift()
    })
  }
  const logs = s.consoleBuffer.slice()
  if (clear) s.consoleBuffer.length = 0
  return { logs }
}

export async function evaluate(expression: string): Promise<object> {
  const s = await getSession()
  // Puppeteer's evaluate accepts a string; it wraps in eval
  const raw = await s.page.evaluate(expression)
  const serialised = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return { result: redactSecrets(serialised ?? 'undefined') }
}

export async function screenshot(fullPage: boolean): Promise<object> {
  const s = await getSession()
  const bytes = await s.page.screenshot({
    type: 'png',
    fullPage,
  })
  // Return base64 so the tool output is JSON-safe; caller can decode.
  const base64 = Buffer.from(bytes).toString('base64')
  return {
    bytes: bytes.length,
    mime: 'image/png',
    data_base64: base64,
    full_page: fullPage,
  }
}

export async function vision(
  question: string,
  returnCoordinates: boolean,
): Promise<object> {
  const s = await getSession()
  const client = getDefaultVisionClient()
  if (!client.isConfigured()) {
    throw new Error(
      `Vision backend (${client.backendName}) not configured. Set ANTHROPIC_API_KEY.`,
    )
  }
  const viewport = s.page.viewport()
  const bytes = await s.page.screenshot({ type: 'png', fullPage: false })

  if (returnCoordinates) {
    if (!client.locate) {
      throw new Error(
        `Vision backend (${client.backendName}) does not support locate(). Upgrade to a client that implements it.`,
      )
    }
    const out = await client.locate(new Uint8Array(bytes), question, {
      viewportWidth: viewport?.width,
      viewportHeight: viewport?.height,
    })
    return {
      backend: client.backendName,
      mode: 'coordinates',
      viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
      description: redactSecrets(out.description ?? ''),
      targets: out.targets,
    }
  }

  const description = await client.describe(new Uint8Array(bytes), question)
  return {
    backend: client.backendName,
    mode: 'describe',
    description: redactSecrets(description),
  }
}

export async function getImages(): Promise<object> {
  const s = await getSession()
  const images = await s.page.evaluate(() => {
    const seen = new Set<string>()
    const out: { src: string; alt: string; width: number; height: number }[] = []
    for (const img of Array.from(document.images)) {
      const src = img.currentSrc || img.src
      if (!src || seen.has(src)) continue
      seen.add(src)
      out.push({
        src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    }
    return out
  })
  return { count: images.length, images: images.slice(0, 200) }
}

// ---------------------------------------------------------------------------
// 純座標動作（canvas / map / vision-first 流程）
// ---------------------------------------------------------------------------

export async function clickAt(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  clickCount: number,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  await s.page.mouse.click(x, y, { button, clickCount, delay: 10 })
  const waits = await settleAndWait(s.page, waitFor)
  return { ok: true, x, y, button, click_count: clickCount, ...waits }
}

export async function mouseMove(x: number, y: number): Promise<object> {
  const s = await getSession()
  await s.page.mouse.move(x, y)
  return { ok: true, x, y }
}

export async function mouseDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps: number,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  await s.page.mouse.move(fromX, fromY)
  await s.page.mouse.down()
  // 分步移動讓網站的拖曳事件鏈（mousemove）能正確觸發
  const stepCount = Math.max(2, steps)
  for (let i = 1; i <= stepCount; i += 1) {
    const t = i / stepCount
    await s.page.mouse.move(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t)
  }
  await s.page.mouse.up()
  const waits = await settleAndWait(s.page, waitFor)
  return {
    ok: true,
    from: { x: fromX, y: fromY },
    to: { x: toX, y: toY },
    steps: stepCount,
    ...waits,
  }
}

export async function wheel(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  waitFor?: WaitForInput,
): Promise<object> {
  const s = await getSession()
  await s.page.mouse.move(x, y)
  // puppeteer 的 wheel 事件透過 CDP 傳送
  await s.page.mouse.wheel({ deltaX, deltaY })
  const waits = await settleAndWait(s.page, waitFor)
  return { ok: true, x, y, delta_x: deltaX, delta_y: deltaY, ...waits }
}

export async function closeBrowser(): Promise<object> {
  await closeSession()
  return { ok: true }
}
