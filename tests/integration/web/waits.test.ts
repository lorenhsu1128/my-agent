/**
 * Unit tests for src/tools/WebBrowserTool/waits.ts
 *
 * 不跑 Chromium — 用 mock Page 驗 dispatchWaitFor 路由 + waitResult 結構。
 */
import { describe, expect, test } from 'bun:test'
import {
  dispatchWaitFor,
  waitForFunction,
  waitForSelector,
  waitForUrlChange,
  type WaitResult,
} from '../../../src/tools/WebBrowserTool/waits'

type MockPage = {
  waitForSelector: (sel: string, opts: unknown) => Promise<unknown>
  waitForFunction: (expr: unknown, opts: unknown, ...args: unknown[]) => Promise<unknown>
  waitForNetworkIdle: (opts: unknown) => Promise<void>
  evaluate: (fn: unknown, ...args: unknown[]) => Promise<unknown>
}

function mockPage(overrides: Partial<MockPage> = {}): MockPage {
  return {
    waitForSelector: async () => undefined,
    waitForFunction: async () => undefined,
    waitForNetworkIdle: async () => undefined,
    evaluate: async () => undefined,
    ...overrides,
  }
}

describe('waits', () => {
  test('waitForSelector success returns waited=true', async () => {
    const page = mockPage()
    const r = await waitForSelector(page as never, '#x')
    expect(r.waited).toBe(true)
    expect(r.strategy).toBe('selector:visible')
    expect(typeof r.elapsedMs).toBe('number')
  })

  test('waitForSelector timeout returns waited=false (does not throw)', async () => {
    const page = mockPage({
      waitForSelector: async () => {
        throw new Error('timeout')
      },
    })
    const r = await waitForSelector(page as never, '#x', { timeoutMs: 10 })
    expect(r.waited).toBe(false)
    expect(r.error).toContain('timeout')
  })

  test('waitForFunction passes expression through', async () => {
    let captured: unknown = null
    const page = mockPage({
      waitForFunction: async (expr: unknown) => {
        captured = expr
      },
    })
    const r = await waitForFunction(page as never, '() => !!window.foo')
    expect(r.waited).toBe(true)
    expect(captured).toBe('() => !!window.foo')
  })

  test('waitForUrlChange rejects invalid regex', async () => {
    const page = mockPage()
    const r = await waitForUrlChange(page as never, '[invalid(')
    expect(r.waited).toBe(false)
    expect(r.error).toContain('Invalid regex')
  })

  test('waitForUrlChange passes regex through waitForFunction', async () => {
    let funcCalled = false
    const page = mockPage({
      waitForFunction: async () => {
        funcCalled = true
      },
    })
    const r = await waitForUrlChange(page as never, '^https://github\\.com/.+')
    expect(r.waited).toBe(true)
    expect(funcCalled).toBe(true)
  })

  test('dispatchWaitFor returns null when wf is undefined', async () => {
    const page = mockPage()
    const r = await dispatchWaitFor(page as never, undefined)
    expect(r).toBeNull()
  })

  test('dispatchWaitFor picks selector first', async () => {
    let selCalled = false
    const page = mockPage({
      waitForSelector: async () => {
        selCalled = true
      },
    })
    const r = (await dispatchWaitFor(page as never, {
      selector: '#x',
      timeout_ms: 100,
    })) as WaitResult
    expect(r.waited).toBe(true)
    expect(selCalled).toBe(true)
  })

  test('dispatchWaitFor picks function when no selector', async () => {
    let fnCalled = false
    const page = mockPage({
      waitForFunction: async () => {
        fnCalled = true
      },
    })
    const r = (await dispatchWaitFor(page as never, {
      function: '() => true',
    })) as WaitResult
    expect(r.waited).toBe(true)
    expect(fnCalled).toBe(true)
  })

  test('dispatchWaitFor picks url_matches', async () => {
    const page = mockPage()
    const r = (await dispatchWaitFor(page as never, {
      url_matches: '^https://',
    })) as WaitResult
    expect(r.waited).toBe(true)
  })

  test('dispatchWaitFor returns null for empty wait_for object', async () => {
    const page = mockPage()
    const r = await dispatchWaitFor(page as never, {})
    expect(r).toBeNull()
  })
})
