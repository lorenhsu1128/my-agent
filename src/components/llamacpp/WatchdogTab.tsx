// M-LLAMACPP-WATCHDOG Phase 3-2：Watchdog tab UI。

import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  WATCHDOG_FIELDS,
  formatMs,
  formatTokens,
  isLayerEffective,
  resetWatchdog,
  type WatchdogFieldId,
} from '../../commands/llamacpp/llamacppManagerLogic.js'
import type { LlamaCppWatchdogConfig } from '../../llamacppConfig/schema.js'

type Mode = 'list' | 'editing'

type Props = {
  cfg: LlamaCppWatchdogConfig
  onChange: (newCfg: LlamaCppWatchdogConfig) => void
  onWritePersistent: () => void
  flash: { text: string; tone: 'info' | 'error' } | null
}

export function WatchdogTab({
  cfg,
  onChange,
  onWritePersistent,
  flash,
}: Props): React.ReactNode {
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>('list')
  const [buffer, setBuffer] = useState('')
  const [editingField, setEditingField] = useState<WatchdogFieldId | null>(null)

  const safeCursor = Math.min(cursor, WATCHDOG_FIELDS.length - 1)

  function commitNumber(): void {
    if (!editingField) return
    const n = Number(buffer)
    if (!Number.isFinite(n) || n <= 0) {
      setMode('list')
      setBuffer('')
      setEditingField(null)
      return
    }
    const spec = WATCHDOG_FIELDS.find(f => f.id === editingField)
    if (spec?.setNumber) onChange(spec.setNumber(cfg, n))
    setMode('list')
    setBuffer('')
    setEditingField(null)
  }

  useInput((input, key) => {
    if (mode === 'editing') {
      if (key.escape) {
        setMode('list')
        setBuffer('')
        setEditingField(null)
        return
      }
      if (key.return) {
        commitNumber()
        return
      }
      if (key.backspace || key.delete) {
        setBuffer(b => b.slice(0, -1))
        return
      }
      if (input && /^[0-9]$/.test(input)) {
        setBuffer(b => b + input)
        return
      }
      return
    }

    // list mode
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(WATCHDOG_FIELDS.length - 1, c + 1))
      return
    }
    if (input === ' ') {
      const spec = WATCHDOG_FIELDS[safeCursor]!
      if (spec.kind === 'toggle' && spec.getBool && spec.setBool) {
        const next = spec.setBool(cfg, !spec.getBool(cfg))
        onChange(next)
      }
      return
    }
    if (key.return) {
      const spec = WATCHDOG_FIELDS[safeCursor]!
      if (spec.kind === 'number' && spec.getNumber) {
        setEditingField(spec.id)
        setBuffer(String(spec.getNumber(cfg)))
        setMode('editing')
      } else if (spec.kind === 'toggle' && spec.getBool && spec.setBool) {
        onChange(spec.setBool(cfg, !spec.getBool(cfg)))
      }
      return
    }
    if (input === 'r' || input === 'R') {
      onChange(resetWatchdog())
      return
    }
    if (input === 'w' || input === 'W') {
      onWritePersistent()
      return
    }
  })

  if (mode === 'editing' && editingField) {
    const spec = WATCHDOG_FIELDS.find(f => f.id === editingField)
    const isMs = editingField.endsWith('Ms')
    return (
      <Box flexDirection="column">
        <Text bold>編輯 {spec?.label.trim()}</Text>
        <Box>
          <Text>新值：</Text>
          <Text>{buffer}</Text>
          <Text color="cyan">_</Text>
          <Text dimColor>  {isMs ? '（毫秒）' : '（tokens）'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter 提交 · Esc 取消 · 只接受正整數</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Watchdog 設定（檔案：~/.my-agent/llamacpp.json）
      </Text>
      <Box marginTop={1} flexDirection="column">
        {WATCHDOG_FIELDS.map((f, i) => {
          const isCur = i === safeCursor
          const isToggle = f.kind === 'toggle'
          const cell = isToggle
            ? f.getBool!(cfg)
              ? '☑'
              : '☐'
            : '   '
          let valueDisplay = ''
          if (!isToggle && f.getNumber) {
            const v = f.getNumber(cfg)
            valueDisplay = f.id.endsWith('Ms')
              ? formatMs(v)
              : formatTokens(v)
          }
          // 標 effective 與否（雙層 AND 才生效）
          let effectiveTag = ''
          if (f.id === 'interChunk.enabled' && isLayerEffective(cfg, 'interChunk'))
            effectiveTag = ' ✓ effective'
          if (f.id === 'reasoning.enabled' && isLayerEffective(cfg, 'reasoning'))
            effectiveTag = ' ✓ effective'
          if (f.id === 'tokenCap.enabled' && isLayerEffective(cfg, 'tokenCap'))
            effectiveTag = ' ✓ effective'
          if (f.id === 'master.enabled' && cfg.enabled)
            effectiveTag = ' ✓ master on'
          return (
            <Box key={f.id}>
              <Text color={isCur ? 'cyan' : undefined}>
                {isCur ? figures.pointer : ' '}
              </Text>
              <Text> {cell} </Text>
              <Text>{f.label.padEnd(22)}</Text>
              <Text color="yellow">{valueDisplay}</Text>
              <Text color="green">{effectiveTag}</Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · Space toggle · Enter 改值 · r reset · w 寫檔 · ←/→ tab · q quit
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          注意：master + 該層皆 ON 才實際生效（雙層 AND）。
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
