/**
 * M-WEB top-level data hook：建立 WS client、首次 fetch 列表、wire 事件 → stores。
 * App 根掛一次。
 */
import { useEffect, useRef } from 'react'
import { api, ApiError } from '../api/client'
import { createWsClient, type WsClient } from '../api/ws'
import type { ServerEvent } from '../api/types'
import { useProjectStore } from '../store/projectStore'
import { useSessionStore } from '../store/sessionStore'
import { useWsStore } from '../store/wsStore'
import { usePermissionStore } from '../store/permissionStore'
import { setWsClient } from './useWsClient'

export function useAppData(): { ws: WsClient | null } {
  const wsRef = useRef<WsClient | null>(null)

  useEffect(() => {
    const projectStore = useProjectStore.getState()
    const sessionStore = useSessionStore.getState()
    const wsStore = useWsStore.getState()

    // 首次抓 project list
    projectStore.setLoading(true)
    api
      .listProjects()
      .then(({ projects }) => {
        projectStore.setProjects(projects)
        if (!projectStore.selectedProjectId && projects.length > 0) {
          projectStore.selectProject(projects[0]!.projectId)
        }
      })
      .catch(err => {
        const msg =
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err)
        projectStore.setError(msg)
      })

    // 起 WS
    const ws = createWsClient()
    wsRef.current = ws
    setWsClient(ws)
    const permStore = usePermissionStore.getState()
    const unsubState = ws.on('state', (s: 'connecting' | 'open' | 'reconnecting' | 'closed') =>
      wsStore.setStatus(s),
    )
    const unsubFrame = ws.on('frame', (e: ServerEvent) => {
      switch (e.type) {
        case 'hello':
          wsStore.setHello(e.sessionId, e.serverTime)
          break
        case 'project.added':
        case 'project.updated':
          projectStore.upsertProject(e.project)
          break
        case 'project.removed':
          projectStore.removeProject(e.projectId)
          break
        case 'permission.pending':
          permStore.setPending({
            projectId: e.projectId,
            toolUseID: e.toolUseID,
            toolName: e.toolName,
            input: e.input,
            riskLevel: e.riskLevel,
            description: e.description,
            affectedPaths: e.affectedPaths,
            sourceClientId: e.sourceClientId,
            receivedAt: Date.now(),
          })
          break
        case 'permission.resolved':
          permStore.clearPending(e.projectId, e.toolUseID)
          break
        case 'permission.modeChanged':
          permStore.setMode(e.projectId, e.mode)
          break
        // turn / cron / memory 事件由各別 component 透過 useTurnEvents 等 hook 訂閱
        default:
          break
      }
    })

    // 訂閱選中的 project（後續切換時 useSubscribeSelected 會重新呼叫）
    const unsubSelect = useProjectStore.subscribe(state => {
      if (state.selectedProjectId) {
        ws.subscribe([state.selectedProjectId])
        // 抓 sessions
        api
          .listSessions(state.selectedProjectId)
          .then(({ sessions, activeSessionId }) => {
            sessionStore.setSessions(state.selectedProjectId!, sessions, activeSessionId)
          })
          .catch(err => {
            console.error('[useAppData] sessions fetch failed', err)
          })
      } else {
        ws.subscribe([])
      }
    })

    return () => {
      unsubState()
      unsubFrame()
      unsubSelect()
      setWsClient(null)
      ws.close()
      wsRef.current = null
    }
  }, [])

  return { ws: wsRef.current }
}
