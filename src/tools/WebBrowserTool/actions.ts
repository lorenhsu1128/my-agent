/**
 * Action handlers for WebBrowserTool (puppeteer-core backed).
 *
 * Security layers applied uniformly:
 *   - URL protocol + secret-exfil check (urlContainsSecret)
 *   - Website blocklist (checkBlocklist)
 *   - DNS-level SSRF rejection (isBlockedAddress)
 *   - Secret redaction on every text returned to the model (redactSecrets)
 */
import { lookup as dnsLookup } from 'dns'
import type { ConsoleMessage } from 'puppeteer-core'
import { isBlockedAddress } from '../../utils/hooks/ssrfGuard.js'
import { checkBlocklist } from '../../utils/web/blocklist.js'
import { redactSecrets, urlContainsSecret } from '../../utils/web/secretScan.js'
import { refToElement, takeSnapshot } from './a11y.js'
import { closeSession, getSession } from './session.js'

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
// Actions
// ---------------------------------------------------------------------------

export async function navigate(url: string): Promise<object> {
  await assertUrlSafe(url)
  const s = await getSession()
  const resp = await s.page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  const finalUrl = s.page.url()
  if (finalUrl !== url) await assertUrlSafe(finalUrl)
  return {
    url: finalUrl,
    status: resp?.status() ?? null,
    title: await s.page.title().catch(() => ''),
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
    tree: redactSecrets(snap.text),
  }
}

export async function click(ref: string): Promise<object> {
  const s = await getSession()
  const el = await refToElement(
    s.page,
    ref,
    s.refEntries,
    s.snapshotGeneration,
    s.generation,
  )
  await el.click({ delay: 10 })
  await el.dispose()
  return { ok: true, ref }
}

export async function type_(ref: string, text: string): Promise<object> {
  const s = await getSession()
  const el = await refToElement(
    s.page,
    ref,
    s.refEntries,
    s.snapshotGeneration,
    s.generation,
  )
  // Focus + clear + type
  await el.focus()
  await el.evaluate(n => {
    if ('value' in n) (n as HTMLInputElement).value = ''
  })
  await el.type(text)
  await el.dispose()
  return { ok: true, ref, typed: text.length }
}

export async function scroll(direction: 'up' | 'down'): Promise<object> {
  const s = await getSession()
  const dy = direction === 'down' ? 500 : -500
  await s.page.evaluate(d => window.scrollBy(0, d), dy)
  return { ok: true, direction }
}

export async function back(): Promise<object> {
  const s = await getSession()
  await s.page.goBack({ waitUntil: 'domcontentloaded' })
  return { ok: true, url: s.page.url() }
}

export async function press(key: string): Promise<object> {
  const s = await getSession()
  await s.page.keyboard.press(key as Parameters<typeof s.page.keyboard.press>[0])
  return { ok: true, key }
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

export async function closeBrowser(): Promise<object> {
  await closeSession()
  return { ok: true }
}
