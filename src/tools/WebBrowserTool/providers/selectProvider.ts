/**
 * Provider selection for WebBrowserTool.
 *
 * Priority (runtime env, no feature flags per ADR-003):
 *   1. `BROWSER_PROVIDER=local|browserbase|browser-use` — explicit override
 *   2. Auto-detect by env:
 *      - BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID  →  browserbase
 *      - BROWSER_USE_API_KEY                           →  browser-use
 *   3. Fallback: local Chromium
 */
import type { BrowserProvider } from './BrowserProvider.js'
import { BrowserUseProvider } from './BrowserUseProvider.js'
import { BrowserbaseProvider } from './BrowserbaseProvider.js'
import { LocalProvider } from './LocalProvider.js'

export type ProviderId = 'local' | 'browserbase' | 'browser-use'

export function selectProvider(): BrowserProvider {
  const explicit = (process.env.BROWSER_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'local') return new LocalProvider()
  if (explicit === 'browserbase') return new BrowserbaseProvider()
  if (explicit === 'browser-use' || explicit === 'browser_use') {
    return new BrowserUseProvider()
  }

  // Auto-detect by available credentials
  const bb = new BrowserbaseProvider()
  if (bb.isConfigured()) return bb

  const bu = new BrowserUseProvider()
  if (bu.isConfigured()) return bu

  return new LocalProvider()
}
