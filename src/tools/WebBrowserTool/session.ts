/**
 * Browser session lifecycle (puppeteer-core).
 *
 * Module-level singleton: one Page + Provider is reused across tool calls
 * so cookies/auth survive multi-step flows. An idle timer closes things
 * after SESSION_IDLE_MS of inactivity; a process-exit hook handles abrupt
 * termination.
 */
import type { Page } from 'puppeteer-core'
import type { RefEntry } from './a11y.js'
import type { BrowserProvider } from './providers/BrowserProvider.js'
import { LocalProvider } from './providers/LocalProvider.js'

export const SESSION_IDLE_MS = 5 * 60 * 1000

export interface SessionState {
  provider: BrowserProvider
  page: Page
  /** Bumps on every mainFrame navigation. */
  generation: number
  /** Ref entries from the latest snapshot (null until snapshot called). */
  refEntries: Map<string, RefEntry> | null
  snapshotGeneration: number
  consoleBuffer: string[] | null
  lastActivity: number
}

let state: SessionState | null = null
let idleTimer: NodeJS.Timeout | null = null
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    closeSession().catch(() => void 0)
  }
  process.once('exit', cleanup)
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    closeSession().catch(() => void 0)
  }, SESSION_IDLE_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function selectProvider(): BrowserProvider {
  // M6 adds cloud providers (Browserbase / Browser Use / Firecrawl) here,
  // gated by env var presence. For M5 we always use local Chromium.
  return new LocalProvider()
}

export async function getSession(): Promise<SessionState> {
  installExitHook()

  if (state && state.page.isClosed()) state = null

  if (!state) {
    const provider = selectProvider()
    const page = await provider.newPage()
    state = {
      provider,
      page,
      generation: 0,
      refEntries: null,
      snapshotGeneration: -1,
      consoleBuffer: null,
      lastActivity: Date.now(),
    }

    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && state) {
        state.generation += 1
        state.refEntries = null
      }
    })
  }

  state.lastActivity = Date.now()
  resetIdleTimer()
  return state
}

export async function closeSession(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const s = state
  state = null
  if (s) {
    try {
      await s.provider.close()
    } catch {
      /* ignore */
    }
  }
}

export async function resetSession(): Promise<void> {
  await closeSession()
}
