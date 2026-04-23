// M-CRON-W3-8a：Cron create wizard router。
//
// 當 LLM 透過 CronCreateTool 建 cron job 時，daemon 不直接寫盤 — 而是把 LLM
// 推斷的完整 task draft 廣播到 attached client，由使用者在 REPL 的 wizard UI
// 上確認 / 修改 / 取消。第一個回應的 client wins（mirror permissionRouter
// 的 first-wins 策略）；5 分鐘無人回 → auto-cancel + 回 tool 'wizard timeout'.
//
// 沒 attached client → router 直接 reject 'no-attached-client'，CronCreateTool
// 收到後回 error 給 LLM；避免 LLM 反覆呼叫卻沒人能確認，產生意外 cron。

import type { DirectConnectServerHandle } from '../server/directConnectServer.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** 完整 task draft — 與 CronTask 結構一致（除了 id 由 daemon 寫入時生成）。 */
export type CronWizardDraft = Record<string, unknown>

export type CronWizardDecision =
  | { kind: 'confirm'; task: CronWizardDraft }
  | { kind: 'cancel'; reason?: string }

export type CronWizardResolved =
  | { kind: 'confirm'; task: CronWizardDraft; resolverClientId: string }
  | { kind: 'cancel'; reason: string; resolverClientId?: string }
  | { kind: 'timeout' }
  | { kind: 'no-clients' }

export interface CronCreateWizardRouter {
  /**
   * 建一個新 wizard request。回傳 promise 解析為使用者決定。同時往所有同
   * project 的 client 廣播 'cronCreateWizard' frame。
   */
  requestWizard(draft: CronWizardDraft): Promise<CronWizardResolved>
  /** 從 broker 餵 inbound 'cronCreateWizardResult' frame。 */
  handleResponse(clientId: string, frame: unknown): boolean
  /** Pending 數量（測試用）。 */
  pendingCount(): number
  /** 取消所有 pending（daemon shutdown）。 */
  cancelAll(reason?: string): void
}

export interface CronCreateWizardRouterOptions {
  server: DirectConnectServerHandle
  projectId: string
  timeoutMs?: number
  /** 注入測試用 timer。 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

type PendingWizard = {
  wizardId: string
  resolve: (r: CronWizardResolved) => void
  timer: unknown
}

let nextId = 1
function generateWizardId(): string {
  return `wiz-${Date.now().toString(36)}-${nextId++}`
}

function isWizardResponse(
  v: unknown,
): v is { type: 'cronCreateWizardResult'; wizardId: string } & (
  | { decision: 'confirm'; task: CronWizardDraft }
  | { decision: 'cancel'; reason?: string }
) {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (r.type !== 'cronCreateWizardResult') return false
  if (typeof r.wizardId !== 'string') return false
  if (r.decision === 'confirm' && r.task && typeof r.task === 'object')
    return true
  if (r.decision === 'cancel') return true
  return false
}

export function createCronCreateWizardRouter(
  opts: CronCreateWizardRouterOptions,
): CronCreateWizardRouter {
  const { server, projectId } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const scheduler = opts.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h =>
      clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  }
  const pending = new Map<string, PendingWizard>()

  const resolveAndCleanup = (
    wizardId: string,
    decision: CronWizardResolved,
  ): void => {
    const p = pending.get(wizardId)
    if (!p) return
    pending.delete(wizardId)
    scheduler.clearTimeout(p.timer)
    // Broadcast resolved so peer clients close their UI.
    try {
      server.broadcast(
        { type: 'cronCreateWizardResolved', wizardId },
        c => c.projectId === projectId,
      )
    } catch {
      // best-effort
    }
    p.resolve(decision)
  }

  return {
    requestWizard(draft) {
      const wizardId = generateWizardId()
      // Find at least one same-project client; if none, reject immediately.
      let attached = 0
      try {
        for (const c of server.registry.list()) {
          if (c.projectId === projectId) attached++
        }
      } catch {
        // registry.list failure → treat as no clients to be safe.
      }
      if (attached === 0) {
        return Promise.resolve<CronWizardResolved>({ kind: 'no-clients' })
      }
      return new Promise<CronWizardResolved>(resolve => {
        const timer = scheduler.setTimeout(() => {
          resolveAndCleanup(wizardId, { kind: 'timeout' })
        }, timeoutMs)
        pending.set(wizardId, { wizardId, resolve, timer })
        try {
          server.broadcast(
            { type: 'cronCreateWizard', wizardId, draft },
            c => c.projectId === projectId,
          )
        } catch {
          // broadcast failure → resolve as no-clients so caller doesn't hang.
          resolveAndCleanup(wizardId, { kind: 'no-clients' })
        }
      })
    },
    handleResponse(clientId, frame) {
      if (!isWizardResponse(frame)) return false
      if (!pending.has(frame.wizardId)) return false
      if (frame.decision === 'confirm') {
        resolveAndCleanup(frame.wizardId, {
          kind: 'confirm',
          task: frame.task,
          resolverClientId: clientId,
        })
      } else {
        resolveAndCleanup(frame.wizardId, {
          kind: 'cancel',
          reason: frame.reason ?? 'user-cancel',
          resolverClientId: clientId,
        })
      }
      return true
    },
    pendingCount() {
      return pending.size
    },
    cancelAll(reason = 'router-cancelled') {
      const ids = Array.from(pending.keys())
      for (const id of ids) {
        resolveAndCleanup(id, { kind: 'cancel', reason })
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Singleton accessor — projectRuntimeFactory installs the router at startup;
// CronCreateTool reaches it via getActiveCronWizardRouter() to know whether
// to gate writes behind a wizard. There's only one daemon process, so a
// module-local Map<projectId, router> is safe.
// -----------------------------------------------------------------------------

const activeRouters = new Map<string, CronCreateWizardRouter>()

export function registerCronWizardRouter(
  projectId: string,
  router: CronCreateWizardRouter,
): void {
  activeRouters.set(projectId, router)
}

export function unregisterCronWizardRouter(projectId: string): void {
  activeRouters.delete(projectId)
}

export function getActiveCronWizardRouter(
  projectId: string,
): CronCreateWizardRouter | undefined {
  return activeRouters.get(projectId)
}

/** Returns any one router (CronCreateTool uses this when it doesn't know the projectId). */
export function getAnyActiveCronWizardRouter():
  | CronCreateWizardRouter
  | undefined {
  for (const r of activeRouters.values()) return r
  return undefined
}
