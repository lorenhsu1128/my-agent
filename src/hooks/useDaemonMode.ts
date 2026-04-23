/**
 * M-DAEMON-6b：REPL hook — 偵測 daemon 活性、管 attached/standalone/reconnecting
 * 狀態，寫入 AppState 供 UI（DaemonStatusIndicator）顯示。
 *
 * 6c 會擴充：frame callback 把 SDKMessage 塞進 REPL messages 陣列、sendInput
 * 取代 local query()。此 hook 先負責 lifecycle + state 映射。
 */
import { useEffect, useRef } from 'react'
import { useSetAppState } from '../state/AppState.js'
import { createDaemonDetector } from '../repl/thinClient/detectDaemon.js'
import {
  createFallbackManager,
  type FallbackManager,
  type ClientMode,
} from '../repl/thinClient/fallbackManager.js'
import type { InboundFrame } from '../repl/thinClient/thinClientSocket.js'
import {
  isAutostartEnabled,
  markAutostartAttempted,
  spawnDetachedDaemon,
} from '../daemon/autostart.js'

export interface PermissionRequestFrameFields {
  toolUseID: string
  inputId: string
  toolName: string
  toolInput: unknown
  riskLevel: 'read' | 'write' | 'destructive'
  description?: string
  affectedPaths?: string[]
}

export interface UseDaemonModeOptions {
  /** Auto-spawn 結果通知 UI（REPL 插 system message）。 */
  onAutostart?: (info: { spawned: boolean; error?: string }) => void
  /** Inbound frame 處理（6c 會接）— 預設 no-op。 */
  onFrame?: (frame: InboundFrame) => void
  /** 收到 permissionRequest 時通知 UI 層（M-DAEMON-7b）。 */
  onPermissionRequest?: (req: PermissionRequestFrameFields) => void
  /** 收到 permissionPending 時通知（其他 client 被 ask 時的旁觀訊息）。 */
  onPermissionPending?: (info: {
    toolUseID: string
    inputId: string
    toolName: string
    sourceClientId: string
    riskLevel: 'read' | 'write' | 'destructive'
    description?: string
  }) => void
  /** Mode 變化時通知（REPL 用來在 attached→standalone 時顯示 system message）。 */
  onModeChange?: (mode: ClientMode) => void
  /**
   * M-DISCORD-2：daemon 拒絕 attach（project 未 load）時呼叫。REPL 應插
   * warning system message 告知使用者需 `my-agent daemon load`（之後 M-DISCORD
   * CLI 會加）；hook 會自動 fallback 到 standalone 模式。
   */
  onAttachRejected?: (info: {
    reason: string
    cwd?: string
    hint?: string
  }) => void
  /**
   * M-DISCORD-4：daemon 廣播 permissionModeChanged 時呼叫。REPL 收到後應
   * apply 新 mode 到 AppState.toolPermissionContext + 插 info system message
   * 讓使用者看到「Discord 改了 mode」。
   */
  onPermissionModeChanged?: (info: {
    projectId: string
    mode: import('../types/permissions.js').PermissionMode
  }) => void
  /**
   * M-CRON-W3-8b：收到 cronCreateWizard 時呼叫。REPL 用來彈 wizard 元件。
   * draft 是 LLM 推斷的完整 task，使用者確認後回 cronCreateWizardResult。
   */
  onCronCreateWizard?: (info: {
    wizardId: string
    draft: Record<string, unknown>
  }) => void
  /** 收到 cronCreateWizardResolved 時呼叫（peer 已決定 → 關 UI）。 */
  onCronCreateWizardResolved?: (info: { wizardId: string }) => void
  /**
   * M-CRON-W3-7：daemon 廣播 cronFireEvent 時呼叫。REPL 用來彈 toast
   * + 更新 StatusLine 的 cron badge。payload 已含 redacted errorMsg。
   */
  onCronFireEvent?: (event: {
    type: 'cronFireEvent'
    taskId: string
    taskName?: string
    schedule: string
    status: 'fired' | 'completed' | 'failed' | 'retrying' | 'skipped'
    startedAt: number
    finishedAt?: number
    durationMs?: number
    errorMsg?: string
    attempt?: number
    skipReason?: string
    source: 'cron'
  }) => void
  /**
   * M-DISCORD-2：REPL 的 cwd，handshake 時送給 daemon。未指定 = backward
   * compat，fallback 到 daemon 的 default runtime。
   */
  cwd?: string
  /**
   * 停用整個 hook（給 daemon 自己內部跑 REPL 的 edge case，避免 attach 自己）。
   * 預設 false — 所有 REPL 都開。
   */
  disabled?: boolean
}

export interface UseDaemonModeResult {
  /** Imperative handle（給 REPL 其他地方 sendInput 等）。 */
  managerRef: React.MutableRefObject<FallbackManager | null>
}

/**
 * Module-level reference to the **current** mounted fallback manager, so code
 * paths that live before the hook call site (like REPL's `onSubmit` useCallback)
 * can still route inputs through daemon without moving the hook call or
 * threading props. Cleared on unmount.
 *
 * Only one REPL can be mounted at a time (the process has a single screen
 * tree), so this singleton is safe.
 */
let currentManager: FallbackManager | null = null
/** Pending permission requests，以 toolUseID 為 key；hook 生命週期內。 */
const pendingPermissions = new Map<string, PermissionRequestFrameFields>()

export function getCurrentDaemonManager(): FallbackManager | null {
  return currentManager
}

/**
 * M-DAEMON-PERMS-B：把當下 TUI permissionMode 推給 daemon。attached 時才真送，
 * 否則 no-op（manager.sendPermissionContextSync 內部判斷）。
 */
export function syncPermissionModeToDaemon(
  mode: import('../types/permissions.js').PermissionMode,
): void {
  currentManager?.sendPermissionContextSync(mode)
}

/** 回最新未決的 permission request；給 REPL `/allow` `/deny` 預設 target 用。 */
export function getLatestPendingPermission():
  | PermissionRequestFrameFields
  | null {
  if (pendingPermissions.size === 0) return null
  // Map 保留 insertion order；取最後一個。
  let latest: PermissionRequestFrameFields | null = null
  for (const v of pendingPermissions.values()) latest = v
  return latest
}

/**
 * 回應 permission request：送 permissionResponse frame 並從 pending map 清掉。
 * 回傳 true 表示成功送出。
 */
export function respondToPermission(
  toolUseID: string,
  decision: 'allow' | 'deny',
  opts?: { updatedInput?: unknown; message?: string },
): boolean {
  const mgr = currentManager
  if (!mgr || mgr.state.mode !== 'attached') return false
  if (!pendingPermissions.has(toolUseID)) return false
  try {
    mgr.sendPermissionResponse(
      toolUseID,
      decision,
      opts?.updatedInput,
      opts?.message,
    )
    pendingPermissions.delete(toolUseID)
    return true
  } catch {
    return false
  }
}

/**
 * M-CRON-W3-8b：回 cron wizard 決定。attached 才真送；回 true 表送出。
 */
export function respondToCronWizard(
  wizardId: string,
  decision: 'confirm' | 'cancel',
  opts?: { task?: Record<string, unknown>; reason?: string },
): boolean {
  const mgr = currentManager
  if (!mgr || mgr.state.mode !== 'attached') return false
  try {
    mgr.sendCronCreateWizardResult(wizardId, decision, opts)
    return true
  } catch {
    return false
  }
}

export function useDaemonMode(
  opts: UseDaemonModeOptions = {},
): UseDaemonModeResult {
  const setAppState = useSetAppState()
  const managerRef = useRef<FallbackManager | null>(null)
  const onFrameRef = useRef<typeof opts.onFrame>(opts.onFrame)
  onFrameRef.current = opts.onFrame
  const onModeChangeRef = useRef<typeof opts.onModeChange>(opts.onModeChange)
  onModeChangeRef.current = opts.onModeChange
  const onPermReqRef = useRef<typeof opts.onPermissionRequest>(
    opts.onPermissionRequest,
  )
  onPermReqRef.current = opts.onPermissionRequest
  const onPermPendingRef = useRef<typeof opts.onPermissionPending>(
    opts.onPermissionPending,
  )
  onPermPendingRef.current = opts.onPermissionPending
  const onAutostartRef = useRef<typeof opts.onAutostart>(opts.onAutostart)
  onAutostartRef.current = opts.onAutostart
  const onAttachRejectedRef = useRef<typeof opts.onAttachRejected>(
    opts.onAttachRejected,
  )
  onAttachRejectedRef.current = opts.onAttachRejected
  const onPermModeChangedRef = useRef<typeof opts.onPermissionModeChanged>(
    opts.onPermissionModeChanged,
  )
  onPermModeChangedRef.current = opts.onPermissionModeChanged
  const onCronFireEventRef = useRef<typeof opts.onCronFireEvent>(
    opts.onCronFireEvent,
  )
  onCronFireEventRef.current = opts.onCronFireEvent
  const onCronWizardRef = useRef<typeof opts.onCronCreateWizard>(
    opts.onCronCreateWizard,
  )
  onCronWizardRef.current = opts.onCronCreateWizard
  const onCronWizardResolvedRef = useRef<
    typeof opts.onCronCreateWizardResolved
  >(opts.onCronCreateWizardResolved)
  onCronWizardResolvedRef.current = opts.onCronCreateWizardResolved
  const cwdRef = useRef<string | undefined>(opts.cwd)
  cwdRef.current = opts.cwd

  useEffect(() => {
    if (opts.disabled) return
    const detector = createDaemonDetector({ pollIntervalMs: 2_000 })
    const manager = createFallbackManager({
      detector,
      cwd: cwdRef.current,
      source: 'repl',
    })
    managerRef.current = manager
    currentManager = manager

    manager.on('attachRejected', rejection => {
      onAttachRejectedRef.current?.(rejection)
    })

    const updateMode = (mode: ClientMode): void => {
      setAppState(prev => {
        if (prev.daemonMode === mode) return prev
        return {
          ...prev,
          daemonMode: mode,
          daemonPort: detector.snapshot.port,
        }
      })
      onModeChangeRef.current?.(mode)
    }
    updateMode(manager.state.mode)
    manager.on('mode', updateMode)

    // M-DAEMON-AUTO-B：首次偵測 standalone → 若 config 啟用 autostart，spawn
    // detached daemon。session flag 保證只試一次（Q1=c：外部 stop 後不 re-spawn）。
    // 非 block — 成功後靠 detector poll 撿到 pid.json 自動切 attached。
    void (async (): Promise<void> => {
      // 等第一次 check 完成（detector 啟動時會自跑一次 runImmediately:true）
      await new Promise(r => setTimeout(r, 30))
      if (manager.state.mode !== 'standalone') return
      if (!isAutostartEnabled()) return
      if (markAutostartAttempted()) return // 已試過就跳過
      const result = spawnDetachedDaemon()
      onAutostartRef.current?.(result)
    })()
    manager.on('frame', f => {
      // M-DAEMON-7b：permission 分派到專屬 callback 方便 REPL 簡單處理。
      if (f.type === 'permissionRequest') {
        const r = f as unknown as PermissionRequestFrameFields & {
          type: string
        }
        pendingPermissions.set(r.toolUseID, r)
        onPermReqRef.current?.(r)
      } else if (f.type === 'permissionModeChanged') {
        onPermModeChangedRef.current?.(
          f as unknown as {
            projectId: string
            mode: import('../types/permissions.js').PermissionMode
          },
        )
      } else if (f.type === 'permissionResolved') {
        // M-DISCORD-AUTOBIND-7：peer（Discord / 其他 REPL）已回覆 → 清 pending
        const r = f as unknown as { toolUseID?: string }
        if (typeof r.toolUseID === 'string') {
          pendingPermissions.delete(r.toolUseID)
        }
      } else if (f.type === 'permissionPending') {
        onPermPendingRef.current?.(
          f as unknown as {
            toolUseID: string
            inputId: string
            toolName: string
            sourceClientId: string
            riskLevel: 'read' | 'write' | 'destructive'
            description?: string
          },
        )
      } else if (f.type === 'cronFireEvent') {
        onCronFireEventRef.current?.(
          f as unknown as Parameters<
            NonNullable<UseDaemonModeOptions['onCronFireEvent']>
          >[0],
        )
      } else if (f.type === 'cronCreateWizard') {
        onCronWizardRef.current?.(
          f as unknown as {
            wizardId: string
            draft: Record<string, unknown>
          },
        )
      } else if (f.type === 'cronCreateWizardResolved') {
        onCronWizardResolvedRef.current?.(
          f as unknown as { wizardId: string },
        )
      }
      onFrameRef.current?.(f)
    })

    return () => {
      manager.off('mode', updateMode)
      void manager.stop()
      detector.stop()
      managerRef.current = null
      if (currentManager === manager) {
        currentManager = null
        pendingPermissions.clear()
      }
      setAppState(prev =>
        prev.daemonMode === 'standalone' && prev.daemonPort === undefined
          ? prev
          : { ...prev, daemonMode: 'standalone', daemonPort: undefined },
      )
    }
    // opts.disabled is the only start/stop trigger; onFrame is captured via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.disabled])

  return { managerRef }
}
