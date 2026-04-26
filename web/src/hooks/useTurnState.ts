/**
 * M-WEB：訂閱選中 project 的 turn state（IDLE/RUNNING/INTERRUPTING）。
 */
import { useEffect, useState } from 'react'
import { useWsClient } from './useWsClient'
import type { ServerEvent } from '../api/types'

export function useTurnState(
  projectId: string | null,
): 'IDLE' | 'RUNNING' | 'INTERRUPTING' {
  const ws = useWsClient()
  const [state, setState] = useState<'IDLE' | 'RUNNING' | 'INTERRUPTING'>(
    'IDLE',
  )
  useEffect(() => {
    setState('IDLE')
    if (!ws || !projectId) return
    return ws.on('frame', (e: ServerEvent) => {
      if (e.type === 'state' && e.projectId === projectId) {
        setState(e.state)
      }
    })
  }, [ws, projectId])
  return state
}
