/**
 * BFS web crawler for WebCrawlTool.
 *
 * - DNS-level SSRF protection via `ssrfGuardedLookup`
 * - Website blocklist enforcement (`checkBlocklist`)
 * - Per-origin robots.txt honoring (simple User-agent: * Disallow: parsing)
 * - Secret redaction on every page body before returning
 * - Per-host rate limiting (min-gap between requests)
 * - cheerio-based link + text extraction
 */

import axios, { AxiosError, type AxiosInstance } from 'axios'
import * as cheerio from 'cheerio'
import { ssrfGuardedLookup } from '../../utils/hooks/ssrfGuard.js'
import { checkBlocklist } from '../../utils/web/blocklist.js'
import { redactSecrets, urlContainsSecret } from '../../utils/web/secretScan.js'

export interface CrawledPage {
  url: string
  title: string
  text: string
  depth: number
  redacted: boolean
  bytes: number
}

export interface CrawlOptions {
  url: string
  maxDepth: number
  maxPages: number
  sameOrigin: boolean
  signal?: AbortSignal
}

export interface CrawlResult {
  pages: CrawledPage[]
  skipped: { url: string; reason: string }[]
  startUrl: string
  pagesCrawled: number
  durationMs: number
}

const USER_AGENT = 'my-agent-WebCrawl/1.0 (+https://github.com/)'
const REQUEST_TIMEOUT_MS = 15_000
const PER_HOST_MIN_GAP_MS = 1_000 // 1 rps per host
const MAX_TEXT_PER_PAGE = 20_000 // chars
const MAX_RESPONSE_BYTES = 2_000_000 // 2 MB

const ROBOTS_CACHE = new Map<string, string[]>() // origin -> disallow prefixes

function makeClient(): AxiosInstance {
  return axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    responseType: 'text',
    validateStatus: () => true,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    lookup: ssrfGuardedLookup,
  })
}

async function fetchRobots(
  client: AxiosInstance,
  origin: string,
): Promise<string[]> {
  const cached = ROBOTS_CACHE.get(origin)
  if (cached) return cached

  const disallow: string[] = []
  try {
    const res = await client.get(`${origin}/robots.txt`)
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      let wildcardSection = false
      for (const raw of res.data.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim()
        if (!line) continue
        const m = /^(User-agent|Disallow|Allow)\s*:\s*(.*)$/i.exec(line)
        if (!m) continue
        const [, field, valueRaw] = m
        const value = (valueRaw ?? '').trim()
        if (field!.toLowerCase() === 'user-agent') {
          wildcardSection = value === '*'
        } else if (
          wildcardSection &&
          field!.toLowerCase() === 'disallow' &&
          value
        ) {
          disallow.push(value)
        }
      }
    }
  } catch {
    // Missing / unreachable robots.txt → treat as allow-all
  }

  ROBOTS_CACHE.set(origin, disallow)
  return disallow
}

function isAllowedByRobots(url: URL, disallow: string[]): boolean {
  if (disallow.length === 0) return true
  const path = url.pathname + (url.search || '')
  for (const d of disallow) {
    if (d === '/') return false
    if (path.startsWith(d)) return false
  }
  return true
}

function extractLinks($: cheerio.CheerioAPI, base: URL): URL[] {
  const out: URL[] = []
  const seen = new Set<string>()
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const trimmed = href.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:'))
      return
    try {
      const resolved = new URL(trimmed, base)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return
      resolved.hash = ''
      const key = resolved.toString()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(resolved)
      }
    } catch {
      /* skip malformed */
    }
  })
  return out
}

function extractText($: cheerio.CheerioAPI): string {
  // Drop noise nodes before serialising
  $('script, style, noscript, svg, iframe, nav, footer, header, form').remove()
  const raw = $('body').text() || $.text()
  return raw.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function extractTitle($: cheerio.CheerioAPI, url: string): string {
  const t = ($('title').first().text() || '').trim()
  return t || url
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const start = Date.now()
  const client = makeClient()
  const pages: CrawledPage[] = []
  const skipped: { url: string; reason: string }[] = []
  const visited = new Set<string>()
  const lastHitByHost = new Map<string, number>()

  let startUrl: URL
  try {
    startUrl = new URL(opts.url)
  } catch {
    throw new Error(`Invalid start URL: ${opts.url}`)
  }
  if (startUrl.protocol !== 'http:' && startUrl.protocol !== 'https:') {
    throw new Error(
      `Only http(s) URLs are supported, got: ${startUrl.protocol}`,
    )
  }

  const startOrigin = startUrl.origin

  type QueueItem = { url: URL; depth: number }
  const queue: QueueItem[] = [{ url: startUrl, depth: 0 }]

  while (queue.length > 0 && pages.length < opts.maxPages) {
    if (opts.signal?.aborted) break

    const next = queue.shift()!
    const urlStr = next.url.toString()
    if (visited.has(urlStr)) continue
    visited.add(urlStr)

    if (urlContainsSecret(urlStr)) {
      skipped.push({ url: urlStr, reason: 'URL contains secret-like token' })
      continue
    }

    const blocked = checkBlocklist(urlStr)
    if (blocked) {
      skipped.push({ url: urlStr, reason: blocked.message })
      continue
    }

    const origin = next.url.origin
    const disallow = await fetchRobots(client, origin)
    if (!isAllowedByRobots(next.url, disallow)) {
      skipped.push({ url: urlStr, reason: 'Blocked by robots.txt' })
      continue
    }

    // Per-host rate limit
    const lastHit = lastHitByHost.get(origin) ?? 0
    const gap = Date.now() - lastHit
    if (gap < PER_HOST_MIN_GAP_MS) {
      await sleep(PER_HOST_MIN_GAP_MS - gap, opts.signal)
    }
    lastHitByHost.set(origin, Date.now())

    let body: string
    let status: number
    let contentType: string
    try {
      const res = await client.get(urlStr, { signal: opts.signal })
      status = res.status
      contentType = String(res.headers['content-type'] ?? '')
      body = typeof res.data === 'string' ? res.data : ''
    } catch (err) {
      const axErr = err as AxiosError
      skipped.push({
        url: urlStr,
        reason: `Fetch failed: ${axErr.message || 'unknown error'}`,
      })
      continue
    }

    if (status < 200 || status >= 400) {
      skipped.push({ url: urlStr, reason: `HTTP ${status}` })
      continue
    }

    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      skipped.push({
        url: urlStr,
        reason: `Unsupported content-type: ${contentType || 'unknown'}`,
      })
      continue
    }

    const $ = cheerio.load(body)
    const title = extractTitle($, urlStr)
    let text = extractText($)
    if (text.length > MAX_TEXT_PER_PAGE) text = text.slice(0, MAX_TEXT_PER_PAGE)

    const redacted = redactSecrets(text)
    const wasRedacted = redacted !== text

    pages.push({
      url: urlStr,
      title,
      text: redacted,
      depth: next.depth,
      redacted: wasRedacted,
      bytes: body.length,
    })

    if (next.depth < opts.maxDepth) {
      const links = extractLinks($, next.url)
      for (const link of links) {
        if (opts.sameOrigin && link.origin !== startOrigin) continue
        if (visited.has(link.toString())) continue
        queue.push({ url: link, depth: next.depth + 1 })
      }
    }
  }

  return {
    pages,
    skipped,
    startUrl: startUrl.toString(),
    pagesCrawled: pages.length,
    durationMs: Date.now() - start,
  }
}
