import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { BrowserCapability, BrowserProvider } from './BrowserProvider.js'

/**
 * Browserbase cloud provider.
 *
 * Creates a session via Browserbase's REST API, receives a CDP WebSocket
 * endpoint, and connects puppeteer to it. Ported from Hermes Agent
 * `tools/browser_providers/browserbase.py`.
 *
 * Requires: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID env vars.
 * Optional: BROWSERBASE_ADVANCED_STEALTH=1 for the Scale-plan stealth mode.
 *
 * Security: cloud browser's egress bypasses our local SSRF guard. Actions
 * must still pre-check URLs via blocklist + urlContainsSecret + DNS lookup
 * before issuing `navigate`; that check runs client-side, so is enforced
 * regardless of provider.
 */

const API_BASE = 'https://api.browserbase.com/v1'
const SESSION_TIMEOUT_MS = 60_000

interface BrowserbaseSession {
  id: string
  connectUrl: string
}

export class BrowserbaseProvider implements BrowserProvider {
  readonly providerName = 'browserbase'

  private browser: Browser | null = null
  private sessionId: string | null = null

  isConfigured(): boolean {
    return Boolean(
      process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID,
    )
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

    const apiKey = process.env.BROWSERBASE_API_KEY
    const projectId = process.env.BROWSERBASE_PROJECT_ID
    if (!apiKey || !projectId) {
      throw new Error(
        'BrowserbaseProvider requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID',
      )
    }

    const advancedStealth = process.env.BROWSERBASE_ADVANCED_STEALTH === '1'

    const resp = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        browserSettings: {
          viewport: { width: 1280, height: 800 },
          ...(advancedStealth ? { advancedStealth: true } : {}),
        },
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `Browserbase session create failed: HTTP ${resp.status}: ${text.slice(0, 300)}`,
      )
    }

    const session = (await resp.json()) as BrowserbaseSession
    this.sessionId = session.id

    this.browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: { width: 1280, height: 800 },
    })

    return this.browser
  }

  async newPage(): Promise<Page> {
    const b = await this.launch()
    // Browserbase session already has a default page/context; reuse if possible
    const pages = await b.pages()
    if (pages.length > 0) return pages[0]!
    return b.newPage()
  }

  async close(): Promise<void> {
    try {
      // disconnect keeps the remote session alive if we want to resume;
      // we force-close via REST to release the paid session slot.
      if (this.browser) await this.browser.disconnect()
    } catch {
      /* ignore */
    }
    this.browser = null

    if (this.sessionId && process.env.BROWSERBASE_API_KEY) {
      try {
        await fetch(`${API_BASE}/sessions/${this.sessionId}`, {
          method: 'POST',
          headers: {
            'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'REQUEST_RELEASE',
            projectId: process.env.BROWSERBASE_PROJECT_ID,
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        /* ignore — session will timeout on their side */
      }
    }
    this.sessionId = null
  }
}
