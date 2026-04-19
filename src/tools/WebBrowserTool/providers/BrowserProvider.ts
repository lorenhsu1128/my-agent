import type { Browser, Page } from 'puppeteer-core'

/**
 * Capabilities a BrowserProvider may or may not support. Actions consult
 * `provider.supports(cap)` before invoking; unsupported actions return a
 * clear error pointing the caller to a different provider.
 */
export type BrowserCapability =
  | 'evaluate' // arbitrary JS in page context
  | 'console' // console log stream
  | 'screenshot' // raw PNG bytes
  | 'accessibility' // a11y snapshot

export interface BrowserProvider {
  readonly providerName: string
  isConfigured(): boolean
  supports(cap: BrowserCapability): boolean
  launch(): Promise<Browser>
  newPage(): Promise<Page>
  close(): Promise<void>
}
