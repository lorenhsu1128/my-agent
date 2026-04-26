/**
 * M-WEB WS connection state（zustand）。
 */
import { create } from 'zustand'
import type { WsConnectionState } from '../api/ws'

interface WsState {
  status: WsConnectionState
  helloSessionId: string | null
  serverTime: number | null
  setStatus(s: WsConnectionState): void
  setHello(sessionId: string, serverTime: number): void
}

export const useWsStore = create<WsState>(set => ({
  status: 'connecting',
  helloSessionId: null,
  serverTime: null,
  setStatus: s => set({ status: s }),
  setHello: (sessionId, serverTime) =>
    set({ helloSessionId: sessionId, serverTime }),
}))
