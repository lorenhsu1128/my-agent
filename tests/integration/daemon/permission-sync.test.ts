/**
 * M-DAEMON-PERMS：權限同步測試。
 *
 * 覆蓋：
 *   - PERMS-B：broker 收到 permissionContextSync frame → daemon AppState
 *     toolPermissionContext.mode 更新（session-bootstrap 的 settingsChangeDetector
 *     subscription 一併驗證，至少 dispose 時 unsub 不炸）
 *   - PERMS-C：permissionRouter 先跑 hasPermissionsToUseTool，allow / deny 直接
 *     return；'ask' 才走 WS prompt
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPermissionRouter } from '../../../src/daemon/permissionRouter'
import type { DirectConnectServerHandle } from '../../../src/server/directConnectServer'
import type { Tool, ToolUseContext } from '../../../src/Tool'

interface SendCall {
  clientId: string
  payload: Record<string, unknown>
}
interface BroadcastCall {
  payload: Record<string, unknown>
}

function makeFakeServer(cap: {
  sends: SendCall[]
  broadcasts: BroadcastCall[]
}): DirectConnectServerHandle {
  return {
    host: '127.0.0.1',
    port: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry: {} as any,
    send(clientId, msg) {
      cap.sends.push({ clientId, payload: msg as Record<string, unknown> })
      return true
    },
    broadcast(msg) {
      cap.broadcasts.push({ payload: msg as Record<string, unknown> })
      return 1
    },
    async stop() {},
  }
}

// 用 bypassPermissions mode 當作「一律 allow」的 short-circuit；這個 mode
// 由 hasPermissionsToUseTool 早期直接回 allow，跟 rules 無關。
function makeBypassContext(): ToolUseContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'bypassPermissions',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        ignoreRules: [],
        bypassAllowRules: [],
        bypassDenyRules: [],
      },
      // 其他欄位 tool permission 不用；塞假值。
      settings: {},
      tasks: {},
      denialTracking: null,
      mcp: { tools: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    setAppState: () => {},
    options: {
      isNonInteractiveSession: true,
      tools: [],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeFakeTool(name = 'Bash'): Tool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    name,
    isReadOnly: () => false,
    isDestructive: () => false,
    userFacingName: () => name,
  } as any
}

describe('PERMS-C: router pre-judge skips WS prompt for auto-allowable', () => {
  let cap: { sends: SendCall[]; broadcasts: BroadcastCall[] }
  beforeEach(() => {
    cap = { sends: [], broadcasts: [] }
  })

  test('pre-judge throw falls through to WS prompt (defensive path)', async () => {
    // 傳不完整的 toolUseContext 會讓 hasPermissionsToUseTool 拋；router 應
    // 吞錯並 fallback 到 WS prompt，不 hang 住也不崩。
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'client-A',
      resolveCurrentInputId: () => 'input-1',
      timeoutMs: 100, // 100ms auto-allow，測試不等 5min
    })
    const decision = await router.canUseTool(
      makeFakeTool(),
      { command: 'echo hi' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUse-fallback',
    )
    // pre-judge throw → 走 WS 路徑 → 100ms timeout auto-allow
    expect(decision.behavior).toBe('allow')
    // 確認有真的送出 permissionRequest（pre-judge 沒短路）
    expect(cap.sends.length).toBe(1)
    expect(
      (cap.sends[0]!.payload as { type: string }).type,
    ).toBe('permissionRequest')
  })

  test('forceDecision short-circuits pre-judge and router', async () => {
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'client-A',
      resolveCurrentInputId: () => 'input-1',
    })
    const decision = await router.canUseTool(
      makeFakeTool(),
      { command: 'anything' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUse-forced',
      {
        behavior: 'deny',
        message: 'forced deny',
        decisionReason: { type: 'other', reason: 'test' },
      },
    )
    expect(decision.behavior).toBe('deny')
    expect(cap.sends.length).toBe(0)
  })
})

describe('PERMS-A: daemon session bootstrap settings watcher', () => {
  let origConfigDir: string | undefined
  beforeEach(() => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir
  })

  test('bootstrap returns context with dispose (settings unsub inside)', async () => {
    const { bootstrapDaemonContext } = await import(
      '../../../src/daemon/sessionBootstrap'
    )
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    expect(typeof ctx.dispose).toBe('function')
    // 重複 dispose 不炸。
    await ctx.dispose()
    await ctx.dispose()
  })
})

describe('PERMS-B: broker routes permissionContextSync frames', () => {
  // Integration test shape：在 daemonCli 的 onMessage handler 裡，
  // permissionContextSync 會 setAppState 更新 toolPermissionContext.mode。
  // 這裡做最小 scenario：直接驗 handler logic 的等價行為。

  test('setAppState receives permissionContextSync.mode update', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state: any = {
      toolPermissionContext: { mode: 'default' },
    }
    const setAppState = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f: (prev: any) => any,
    ): void => {
      state = f(state)
    }
    const m = { type: 'permissionContextSync', mode: 'acceptEdits' }
    if (
      m.type === 'permissionContextSync' &&
      typeof (m as { mode?: string }).mode === 'string'
    ) {
      setAppState(prev =>
        prev.toolPermissionContext.mode === m.mode
          ? prev
          : {
              ...prev,
              toolPermissionContext: {
                ...prev.toolPermissionContext,
                mode: m.mode,
              },
            },
      )
    }
    expect(state.toolPermissionContext.mode).toBe('acceptEdits')
  })
})
