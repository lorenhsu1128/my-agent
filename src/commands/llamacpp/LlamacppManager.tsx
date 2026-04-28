// M-LLAMACPP-WATCHDOG Phase 3-1：LlamacppManager 主 master TUI。
// 2 tabs：Watchdog / Slots，←/→ 切換（mirror MemoryManager pattern）。

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { WatchdogTab } from '../../components/llamacpp/WatchdogTab.js'
import { SlotsTab } from '../../components/llamacpp/SlotsTab.js'
import { EndpointsTab } from '../../components/llamacpp/EndpointsTab.js'
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
  testRemoteEndpoint,
  writeRemoteConfig,
  writeRoutingConfig,
  writeWatchdogConfig,
} from './llamacppMutations.js'
import {
  getCurrentDaemonManager,
  sendLlamacppConfigMutationToDaemon,
} from '../../hooks/useDaemonMode.js'
import type {
  LlamaCppRemoteConfig,
  LlamaCppRoutingConfig,
  LlamaCppWatchdogConfig,
} from '../../llamacppConfig/schema.js'

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
  // M-LLAMACPP-REMOTE：endpoints tab working draft — remote 區塊與 routing 表
  const [remote, setRemote] = useState<LlamaCppRemoteConfig>(
    () => getLlamaCppConfigSnapshot().remote,
  )
  const [routing, setRouting] = useState<LlamaCppRoutingConfig>(
    () => getLlamaCppConfigSnapshot().routing,
  )
  const [flash, setFlash] = useState<Flash | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Auto-clear flash
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  // 訂閱 daemon llamacpp.configChanged 廣播 → 重讀 cfg / remote / routing
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string; changedSection?: string }): void => {
      if (f.type === 'llamacpp.configChanged') {
        const section = f.changedSection
        if (section === 'watchdog' || section === undefined) {
          setCfg(getEffectiveWatchdogConfig())
        }
        if (section === 'remote' || section === undefined) {
          setRemote(getLlamaCppConfigSnapshot().remote)
        }
        if (section === 'routing' || section === undefined) {
          setRouting(getLlamaCppConfigSnapshot().routing)
        }
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

  async function persistEndpoints(
    nextRemote: LlamaCppRemoteConfig,
    nextRouting: LlamaCppRoutingConfig,
  ): Promise<void> {
    // 兩個 mutation 各送一次（daemon attached 走 RPC、否則走本機 fallback）
    const rRemote = await sendLlamacppConfigMutationToDaemon(
      { op: 'setRemote', payload: nextRemote },
      10_000,
    )
    if (rRemote === null) {
      const local = await writeRemoteConfig(nextRemote)
      if (!local.ok) {
        setFlash({ text: `remote: ${local.error}`, tone: 'error' })
        return
      }
    } else if (!rRemote.ok) {
      setFlash({ text: `remote: ${rRemote.error}`, tone: 'error' })
      return
    }
    const rRouting = await sendLlamacppConfigMutationToDaemon(
      { op: 'setRouting', payload: nextRouting },
      10_000,
    )
    if (rRouting === null) {
      const local = await writeRoutingConfig(nextRouting)
      if (!local.ok) {
        setFlash({ text: `routing: ${local.error}`, tone: 'error' })
        return
      }
    } else if (!rRouting.ok) {
      setFlash({ text: `routing: ${rRouting.error}`, tone: 'error' })
      return
    }
    setFlash({ text: '已寫入 remote + routing', tone: 'info' })
  }

  async function sendOrLocalTestRemote(
    target: LlamaCppRemoteConfig,
  ): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    // daemon 路徑（attached）
    const r = await sendLlamacppConfigMutationToDaemon(
      {
        op: 'testRemote',
        payload: { baseUrl: target.baseUrl, apiKey: target.apiKey },
      },
      10_000,
    )
    if (r !== null) {
      if (r.ok) {
        return { ok: true, models: r.data?.models ?? [] }
      }
      return { ok: false, error: r.error ?? 'unknown' }
    }
    // standalone fallback
    const local = await testRemoteEndpoint({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
    })
    return local.ok
      ? { ok: true, models: local.models }
      : { ok: false, error: local.error }
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
        ) : tab === 'slots' ? (
          <SlotsTab flash={flash} setFlash={setFlash} />
        ) : (
          <EndpointsTab
            remote={remote}
            routing={routing}
            onChangeRemote={setRemote}
            onChangeRouting={setRouting}
            onSave={() => {
              void persistEndpoints(remote, routing)
            }}
            onTestConnection={async () => {
              setFlash({ text: '測試連線中…', tone: 'info' })
              const res = await sendOrLocalTestRemote(remote)
              if (res.ok) {
                setFlash({
                  text: `OK · ${res.models.length} 個 model：${res.models.slice(0, 3).join(', ')}${res.models.length > 3 ? '…' : ''}`,
                  tone: 'info',
                })
              } else {
                setFlash({ text: `失敗：${res.error}`, tone: 'error' })
              }
            }}
            flash={flash}
          />
        )}
      </Box>
    </Box>
  )
}
