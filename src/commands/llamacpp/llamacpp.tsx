// M-LLAMACPP-WATCHDOG Phase 3-4：`/llamacpp` Hybrid 入口。
// 無參數 → render TUI；有參數 → 直接套用 mutation 並印結果（plain text）。

import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { LlamacppManager } from './LlamacppManager.js'
import { HELP_TEXT, parseLlamacppArgs } from './argsParser.js'
import {
  getEffectiveWatchdogConfig,
  getLlamaCppConfigSnapshot,
} from '../../llamacppConfig/loader.js'
import {
  fetchSlots,
  killSlot,
  setSessionWatchdogOverride,
  writeWatchdogConfig,
} from './llamacppMutations.js'
import {
  WATCHDOG_FIELDS,
  formatMs,
  formatTokens,
  isLayerEffective,
  resetWatchdog,
  turnAllOff,
  turnAllOn,
} from './llamacppManagerLogic.js'
import { sendLlamacppConfigMutationToDaemon } from '../../hooks/useDaemonMode.js'
import type { LlamaCppWatchdogConfig } from '../../llamacppConfig/schema.js'

function formatWatchdogStatus(cfg: LlamaCppWatchdogConfig): string {
  const lines: string[] = []
  lines.push(`master.enabled = ${cfg.enabled ? '✓ on' : '✗ off'}`)
  for (const f of WATCHDOG_FIELDS) {
    if (f.id === 'master.enabled') continue
    if (f.kind === 'toggle') {
      const v = f.getBool!(cfg)
      const layer = f.id.split('.')[0] as
        | 'interChunk'
        | 'reasoning'
        | 'tokenCap'
      const eff = isLayerEffective(cfg, layer)
      lines.push(
        `  ${f.label.trim().padEnd(22)} ${v ? '✓ on' : '✗ off'}${eff ? '  (effective)' : ''}`,
      )
    } else {
      const v = f.getNumber!(cfg)
      const formatted = f.id.endsWith('Ms')
        ? formatMs(v)
        : formatTokens(v)
      lines.push(`     ${f.label.trim().padEnd(20)} ${formatted}`)
    }
  }
  return lines.join('\n')
}

async function applyMutation(
  newCfg: LlamaCppWatchdogConfig,
  session: boolean,
): Promise<{ ok: boolean; message: string }> {
  if (session) {
    setSessionWatchdogOverride(newCfg)
    return { ok: true, message: '已套用 session-only override（不寫檔）' }
  }
  // attached → daemon
  const dRes = await sendLlamacppConfigMutationToDaemon(
    { op: 'setWatchdog', payload: newCfg },
    10_000,
  )
  if (dRes !== null) {
    return dRes.ok
      ? { ok: true, message: '已寫入 daemon + 廣播' }
      : { ok: false, message: `daemon: ${dRes.error}` }
  }
  const r = await writeWatchdogConfig(newCfg)
  return r.ok ? { ok: true, message: r.message } : { ok: false, message: r.error }
}

async function runArgsCommand(
  args: string,
): Promise<{ display: 'system' | 'condensed'; text: string }> {
  const parsed = parseLlamacppArgs(args)

  if (parsed.kind === 'help') {
    return { display: 'system', text: HELP_TEXT }
  }
  if (parsed.kind === 'error') {
    return { display: 'system', text: `❌ ${parsed.message}\n\n${HELP_TEXT}` }
  }
  if (parsed.kind === 'watchdog-status') {
    const cfg = getEffectiveWatchdogConfig()
    return {
      display: 'system',
      text: `Watchdog 狀態：\n${formatWatchdogStatus(cfg)}`,
    }
  }
  if (parsed.kind === 'slots-status') {
    const r = await fetchSlots()
    if (!r.ok) return { display: 'system', text: `slots fetch 失敗：${r.error}` }
    const lines = r.slots.map(
      s =>
        `slot ${s.id}  ${s.isProcessing ? 'processing' : 'idle      '}  decoded=${s.nDecoded}  remain=${s.nRemain}`,
    )
    return {
      display: 'system',
      text: `server: ${getLlamaCppConfigSnapshot().baseUrl}\n${lines.join('\n')}`,
    }
  }
  if (parsed.kind === 'slots-kill') {
    const r = await killSlot(parsed.slotId)
    if (r.ok) return { display: 'system', text: `已送 erase slot ${parsed.slotId}` }
    if (r.status === 501)
      return {
        display: 'system',
        text: `server 未啟用 slot cancel — 請以 --slot-save-path 重啟 llama-server`,
      }
    return { display: 'system', text: `kill 失敗：${r.error}` }
  }

  // mutation 系列
  const cur = getEffectiveWatchdogConfig()
  let next: LlamaCppWatchdogConfig | null = null
  if (parsed.kind === 'watchdog-master') {
    next = { ...cur, enabled: parsed.enabled }
  } else if (parsed.kind === 'watchdog-toggle') {
    const f = WATCHDOG_FIELDS.find(x => x.id === parsed.field)
    if (f?.setBool) next = f.setBool(cur, parsed.enabled)
  } else if (parsed.kind === 'watchdog-set-number') {
    const f = WATCHDOG_FIELDS.find(x => x.id === parsed.field)
    if (f?.setNumber) next = f.setNumber(cur, parsed.value)
  } else if (parsed.kind === 'watchdog-all') {
    next = parsed.on ? turnAllOn(cur) : turnAllOff(cur)
  } else if (parsed.kind === 'watchdog-reset') {
    next = resetWatchdog()
  }

  if (!next) {
    return { display: 'system', text: '❌ 無法套用 mutation（內部錯誤）' }
  }
  const session = (parsed as { session?: boolean }).session === true
  const res = await applyMutation(next, session)
  return {
    display: 'system',
    text: `${res.ok ? '✓' : '❌'} ${res.message}\n\n${formatWatchdogStatus(next)}`,
  }
}

function LlamacppCommand({
  onDone,
  args,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  args: string
}): React.ReactNode {
  return (
    <LlamacppManager
      onExit={(summary: string) => {
        onDone(summary, { display: 'system' })
      }}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const argsStr = (args ?? '').trim()
  if (argsStr === '') {
    // 無參數 → TUI
    return <LlamacppCommand onDone={onDone} args="" />
  }
  // 有參數 → 直接執行不開 TUI
  const r = await runArgsCommand(argsStr)
  onDone(r.text, { display: r.display })
  return null
}
