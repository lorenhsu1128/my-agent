/**
 * Firecrawl /v1/scrape adapter.
 *
 * Used by WebCrawlTool as an optional fetcher backend — switch on by setting
 * `WEBCRAWL_BACKEND=firecrawl` and `FIRECRAWL_API_KEY`. Each URL the BFS
 * visits is fetched by Firecrawl (which renders JS and handles anti-bot)
 * instead of our raw axios+SSRF path.
 *
 * Hermes's `tools/web_tools.py` uses Firecrawl as a first-class backend with
 * its own /v1/crawl endpoint (async, multi-page). We skip that: our BFS is
 * already good enough, and delegating per-URL scrape is lower risk + gives
 * us the main benefit (JS rendering).
 */

const DEFAULT_API_BASE = 'https://api.firecrawl.dev'
const TIMEOUT_MS = 30_000

interface ScrapeResponse {
  success: boolean
  data?: {
    markdown?: string
    html?: string
    metadata?: {
      title?: string
      statusCode?: number
      sourceURL?: string
    }
  }
  error?: string
}

export interface FirecrawlPage {
  url: string
  status: number
  html: string
  title: string
}

export function isFirecrawlBackendActive(): boolean {
  return (
    (process.env.WEBCRAWL_BACKEND ?? '').toLowerCase() === 'firecrawl' &&
    Boolean(process.env.FIRECRAWL_API_KEY)
  )
}

export async function firecrawlScrape(
  url: string,
  signal?: AbortSignal,
): Promise<FirecrawlPage> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set')
  const base = process.env.FIRECRAWL_API_BASE ?? DEFAULT_API_BASE

  const resp = await fetch(`${base}/v1/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['html'],
      onlyMainContent: false,
    }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(
      `Firecrawl scrape failed: HTTP ${resp.status}: ${text.slice(0, 300)}`,
    )
  }

  const body = (await resp.json()) as ScrapeResponse
  if (!body.success || !body.data) {
    throw new Error(`Firecrawl scrape error: ${body.error ?? 'unknown'}`)
  }

  return {
    url: body.data.metadata?.sourceURL ?? url,
    status: body.data.metadata?.statusCode ?? 200,
    html: body.data.html ?? '',
    title: body.data.metadata?.title ?? '',
  }
}
