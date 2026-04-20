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

export interface UseDaemonModeOptions {
  /** Inbound frame 處理（6c 會接）— 預設 no-op。 */
  onFrame?: (frame: InboundFrame) => void
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

export function useDaemonMode(
  opts: UseDaemonModeOptions = {},
): UseDaemonModeResult {
  const setAppState = useSetAppState()
  const managerRef = useRef<FallbackManager | null>(null)
  const onFrameRef = useRef<typeof opts.onFrame>(opts.onFrame)
  onFrameRef.current = opts.onFrame

  useEffect(() => {
    if (opts.disabled) return
    const detector = createDaemonDetector({ pollIntervalMs: 2_000 })
    const manager = createFallbackManager({ detector })
    managerRef.current = manager

    const updateMode = (mode: ClientMode): void => {
      setAppState(prev => {
        if (prev.daemonMode === mode) return prev
        return {
          ...prev,
          daemonMode: mode,
          daemonPort: detector.snapshot.port,
        }
      })
    }
    updateMode(manager.state.mode)
    manager.on('mode', updateMode)
    manager.on('frame', f => {
      onFrameRef.current?.(f)
    })

    return () => {
      manager.off('mode', updateMode)
      void manager.stop()
      detector.stop()
      managerRef.current = null
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
