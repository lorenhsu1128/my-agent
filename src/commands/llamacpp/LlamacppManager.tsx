// M-LLAMACPP-WATCHDOG Phase 3-1：LlamacppManager 主 master TUI。
// 2 tabs：Watchdog / Slots，←/→ 切換（mirror MemoryManager pattern）。

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { WatchdogTab } from '../../components/llamacpp/WatchdogTab.js'
import { SlotsTab } from '../../components/llamacpp/SlotsTab.js'
import {
  TABS,
  type TabId,
  nextTab,
  prevTab,
} from './llamacppManagerLogic.js'
import {
  getEffectiveWatchdogConfig,
  getLlamaCppConfigSnapshot,
} from '../../llamacppConfig/loader.js'
import {
  setSessionWatchdogOverride,
  writeWatchdogConfig,
} from './llamacppMutations.js'
import {
  getCurrentDaemonManager,
  sendLlamacppConfigMutationToDaemon,
} from '../../hooks/useDaemonMode.js'
import type { LlamaCppWatchdogConfig } from '../../llamacppConfig/schema.js'

type Flash = { text: string; tone: 'info' | 'error' }

export type Props = {
  onExit: (summary: string) => void
  /** 啟動時的 tab（預設 watchdog） */
  initialTab?: TabId
}

export function LlamacppManager({ onExit, initialTab }: Props): React.ReactNode {
  const [tab, setTab] = useState<TabId>(initialTab ?? 'watchdog')
  // 起始 cfg 從 effective（含 env override）；mutation 維持 working draft
  const [cfg, setCfg] = useState<LlamaCppWatchdogConfig>(() =>
    getEffectiveWatchdogConfig(),
  )
  const [flash, setFlash] = useState<Flash | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Auto-clear flash
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  // 訂閱 daemon llamacpp.configChanged 廣播 → 重讀 cfg
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string }): void => {
      if (f.type === 'llamacpp.configChanged') {
        setCfg(getEffectiveWatchdogConfig())
        setReloadKey(n => n + 1)
      }
    }
    mgr.on('frame', handler as never)
    return () => mgr.off('frame', handler as never)
  }, [])

  function applyChange(newCfg: LlamaCppWatchdogConfig): void {
    setCfg(newCfg)
    // 預設行為：寫檔 + session override 暫存（hot-reload 也立即生效）
    setSessionWatchdogOverride(newCfg)
    void persistChange(newCfg, false)
  }

  async function persistChange(
    newCfg: LlamaCppWatchdogConfig,
    explicit: boolean,
  ): Promise<void> {
    // attached 走 daemon RPC
    const dRes = await sendLlamacppConfigMutationToDaemon(
      { op: 'setWatchdog', payload: newCfg },
      10_000,
    )
    if (dRes !== null) {
      if (dRes.ok) {
        if (explicit) setFlash({ text: '已寫入 daemon + 廣播', tone: 'info' })
      } else {
        setFlash({ text: `daemon: ${dRes.error}`, tone: 'error' })
      }
      return
    }
    // standalone fallback
    const r = await writeWatchdogConfig(newCfg)
    if (r.ok) {
      if (explicit) setFlash({ text: r.message, tone: 'info' })
    } else {
      setFlash({ text: r.error, tone: 'error' })
    }
  }

  useInput((input, key) => {
    // Watchdog tab + Slots tab 都自己掛 useInput；
    // 主層只處理 ←/→ 切 tab + q quit
    if (key.escape || input === 'q') {
      onExit('LlamaCpp 設定已關閉')
      return
    }
    if (key.leftArrow) {
      setTab(prevTab(tab))
      return
    }
    if (key.rightArrow) {
      setTab(nextTab(tab))
      return
    }
  })

  return (
    <Box flexDirection="column">
      {/* Tab header */}
      <Box>
        <Text bold>LlamaCpp · </Text>
        {TABS.map((t, i) => {
          const isActive = t.id === tab
          return (
            <React.Fragment key={t.id}>
              {i > 0 && <Text dimColor>  </Text>}
              {isActive ? (
                <Text bold color="cyan">
                  ‹ {t.label} ›
                </Text>
              ) : (
                <Text dimColor>{t.label}</Text>
              )}
            </React.Fragment>
          )
        })}
        <Text dimColor>    (←/→ 切 tab)</Text>
      </Box>

      <Box marginTop={1}>
        {tab === 'watchdog' ? (
          <WatchdogTab
            cfg={cfg}
            onChange={applyChange}
            onWritePersistent={() => {
              void persistChange(cfg, true)
            }}
            flash={flash}
          />
        ) : (
          <SlotsTab flash={flash} setFlash={setFlash} />
        )}
      </Box>
    </Box>
  )
}
