/**
 * 全域單例 WS client — 由 useAppData 設定，其他 component 透過此 hook 取用。
 */
import { useEffect, useState } from 'react'
import type { WsClient } from '../api/ws'

let currentClient: WsClient | null = null
const subscribers: Array<(c: WsClient | null) => void> = []

export function setWsClient(c: WsClient | null): void {
  currentClient = c
  for (const sub of subscribers) sub(c)
}

export function useWsClient(): WsClient | null {
  const [c, setC] = useState<WsClient | null>(currentClient)
  useEffect(() => {
    const sub = (next: WsClient | null) => setC(next)
    subscribers.push(sub)
    return () => {
      const i = subscribers.indexOf(sub)
      if (i >= 0) subscribers.splice(i, 1)
    }
  }, [])
  return c
}
