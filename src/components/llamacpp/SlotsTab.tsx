// M-LLAMACPP-WATCHDOG Phase 3-3：Slots tab UI（5s poll + K kill）。

import figures from 'figures'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  fetchSlots,
  killSlot,
  type SlotInfo,
} from '../../commands/llamacpp/llamacppMutations.js'
import { getLlamaCppConfigSnapshot } from '../../llamacppConfig/loader.js'

type Flash = { text: string; tone: 'info' | 'error' }

type Props = {
  flash: Flash | null
  setFlash: (f: Flash | null) => void
}

export function SlotsTab({ flash, setFlash }: Props): React.ReactNode {
  const [slots, setSlots] = useState<SlotInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [reloadTok, setReloadTok] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const r = await fetchSlots()
      if (cancelled) return
      if (r.ok) {
        setSlots(r.slots)
        setError(null)
      } else {
        setError(r.error)
      }
    }
    void load()
    const t = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [reloadTok])

  const safeCursor = Math.min(cursor, Math.max(0, slots.length - 1))
  const selected = slots[safeCursor]

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(slots.length - 1, c + 1))
      return
    }
    if (input === 'R' || input === 'r') {
      setReloadTok(n => n + 1)
      return
    }
    if (input === 'K' || input === 'k') {
      if (!selected) return
      void (async () => {
        const r = await killSlot(selected.id)
        if (r.ok) {
          setFlash({ text: `已送 erase slot ${selected.id}`, tone: 'info' })
          setReloadTok(n => n + 1)
        } else {
          if (r.status === 501) {
            setFlash({
              text: `server 未啟用 slot cancel — 請以 --slot-save-path 重啟 llama-server`,
              tone: 'error',
            })
          } else {
            setFlash({ text: `kill 失敗：${r.error}`, tone: 'error' })
          }
        }
      })()
      return
    }
  })

  const cfg = getLlamaCppConfigSnapshot()

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>server: </Text>
        <Text>{cfg.baseUrl}</Text>
        <Text dimColor>   model: </Text>
        <Text>{cfg.model}</Text>
      </Box>
      {error && (
        <Box>
          <Text color="red">load error: {error}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {slots.length === 0 ? (
          <Text dimColor>(無 slot 資料；server 可能不可達)</Text>
        ) : (
          slots.map((s, i) => {
            const isCur = i === safeCursor
            const stateColor = s.isProcessing ? 'yellow' : 'green'
            const stateLabel = s.isProcessing ? 'processing' : 'idle'
            const note =
              s.isProcessing && s.nDecoded > 20_000
                ? '  ← reasoning loop?'
                : ''
            return (
              <Box key={s.id}>
                <Text color={isCur ? 'cyan' : undefined}>
                  {isCur ? figures.pointer : ' '}
                </Text>
                <Text> slot {s.id}  </Text>
                <Text color={stateColor}>{stateLabel.padEnd(11)}</Text>
                <Text dimColor>n_decoded=</Text>
                <Text>{String(s.nDecoded).padStart(6)}</Text>
                <Text dimColor>  remain=</Text>
                <Text>{String(s.nRemain).padStart(6)}</Text>
                <Text color="red">{note}</Text>
              </Box>
            )
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · K kill slot（需 server 帶 --slot-save-path） · R 重 fetch · ←/→ tab · q quit
        </Text>
      </Box>
      {flash && (
        <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
          {flash.text}
        </Text>
      )}
    </Box>
  )
}
