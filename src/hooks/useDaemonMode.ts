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

  useEffect(() => {
    if (opts.disabled) return
    const detector = createDaemonDetector({ pollIntervalMs: 2_000 })
    const manager = createFallbackManager({ detector })
    managerRef.current = manager
    currentManager = manager

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
