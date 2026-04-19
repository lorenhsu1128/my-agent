import { existsSync } from 'fs'
import { join } from 'path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { BrowserCapability, BrowserProvider } from './BrowserProvider.js'

/**
 * Local headless Chromium via puppeteer-core.
 *
 * Why puppeteer-core, not playwright-core? Playwright on bun+Windows
 * hangs in its default `--remote-debugging-pipe` transport, and
 * `connectOverCDP` to a spawned Chromium also hangs. Puppeteer defaults
 * to WebSocket CDP which works cleanly on bun. We reuse the Chromium
 * binary installed by `bunx playwright install chromium` so there's no
 * second browser download.
 */

const LAUNCH_TIMEOUT_MS = 60_000

function findChromeExecutable(): string {
  const base = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'ms-playwright')
    : process.env.HOME
      ? join(process.env.HOME, '.cache', 'ms-playwright')
      : ''
  const candidates =
    process.platform === 'win32'
      ? [
          join(base, 'chromium-1217', 'chrome-win64', 'chrome.exe'),
          join(base, 'chromium-1217', 'chrome-win', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            join(
              base,
              'chromium-1217',
              'chrome-mac',
              'Chromium.app',
              'Contents',
              'MacOS',
              'Chromium',
            ),
          ]
        : [join(base, 'chromium-1217', 'chrome-linux', 'chrome')]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    `Chromium not found under ${base}. Run once: bunx playwright install chromium`,
  )
}

export class LocalProvider implements BrowserProvider {
  readonly providerName = 'local-chromium'

  private browser: Browser | null = null

  isConfigured(): boolean {
    return true
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
    const exe = findChromeExecutable()
    this.browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
      ],
      defaultViewport: { width: 1280, height: 800 },
    })
    return this.browser
  }

  async newPage(): Promise<Page> {
    const b = await this.launch()
    return b.newPage()
  }

  async close(): Promise<void> {
    try {
      if (this.browser) await this.browser.close()
    } catch {
      /* ignore */
    }
    this.browser = null
  }
}
