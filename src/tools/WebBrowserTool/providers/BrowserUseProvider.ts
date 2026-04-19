import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { BrowserCapability, BrowserProvider } from './BrowserProvider.js'

/**
 * Browser Use cloud provider.
 *
 * Creates a session via Browser Use's cloud API, receives a CDP WebSocket
 * endpoint, and connects puppeteer. Ported from Hermes Agent
 * `tools/browser_providers/browser_use.py`.
 *
 * Requires: BROWSER_USE_API_KEY env var.
 * Optional: BROWSER_USE_API_BASE (defaults to https://api.browser-use.com)
 *
 * Hermes supports a "managed Nous gateway" for Browser Use; we do not
 * port that because my-agent has no equivalent gateway. Direct API-key
 * path only — it's self-contained and works offline of any managed infra.
 */

const DEFAULT_API_BASE = 'https://api.browser-use.com'
const SESSION_TIMEOUT_MS = 60_000

interface BrowserUseSession {
  sessionId: string
  wsUrl: string
}

export class BrowserUseProvider implements BrowserProvider {
  readonly providerName = 'browser-use'

  private browser: Browser | null = null
  private sessionId: string | null = null

  isConfigured(): boolean {
    return Boolean(process.env.BROWSER_USE_API_KEY)
  }

  supports(cap: BrowserCapability): boolean {
    switch (cap) {
      case 'evaluate':
      case 'console':
      case 'screenshot':
      case 'accessibility':
        return true
    }
  }

  async launch(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser

    const apiKey = process.env.BROWSER_USE_API_KEY
    if (!apiKey) throw new Error('BrowserUseProvider requires BROWSER_USE_API_KEY')

    const base = process.env.BROWSER_USE_API_BASE ?? DEFAULT_API_BASE

    const resp = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        viewport: { width: 1280, height: 800 },
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `Browser Use session create failed: HTTP ${resp.status}: ${text.slice(0, 300)}`,
      )
    }

    const session = (await resp.json()) as BrowserUseSession
    this.sessionId = session.sessionId

    this.browser = await puppeteer.connect({
      browserWSEndpoint: session.wsUrl,
      defaultViewport: { width: 1280, height: 800 },
    })

    return this.browser
  }

  async newPage(): Promise<Page> {
    const b = await this.launch()
    const pages = await b.pages()
    if (pages.length > 0) return pages[0]!
    return b.newPage()
  }

  async close(): Promise<void> {
    try {
      if (this.browser) await this.browser.disconnect()
    } catch {
      /* ignore */
    }
    this.browser = null

    if (this.sessionId && process.env.BROWSER_USE_API_KEY) {
      try {
        const base = process.env.BROWSER_USE_API_BASE ?? DEFAULT_API_BASE
        await fetch(`${base}/v1/sessions/${this.sessionId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${process.env.BROWSER_USE_API_KEY}`,
          },
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        /* ignore */
      }
    }
    this.sessionId = null
  }
}
