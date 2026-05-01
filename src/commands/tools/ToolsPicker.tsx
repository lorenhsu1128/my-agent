import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { UNTOGGLEABLE_TOOLS } from '../../constants/untoggleableTools.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { getAllBaseTools } from '../../tools.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

type Props = {
  onExit: (summary: string) => void
}

type Mode = 'picking' | 'done'

interface Row {
  name: string
  isUntoggleable: boolean
  /** Global persistent disable (read from userSettings.disabledTools at render) */
  disabledGlobal: boolean
  /** Project persistent disable (projectSettings.disabledTools) */
  disabledProject: boolean
}

function readPersistedDisabled(
  source: 'userSettings' | 'projectSettings',
): Set<string> {
  const s = getSettingsForSource(source)
  const list = s?.disabledTools
  return new Set(Array.isArray(list) ? list : [])
}

function writePersistedDisabled(
  source: 'userSettings' | 'projectSettings',
  names: Set<string>,
): { error: Error | null } {
  const prev = getSettingsForSource(source) ?? {}
  const filtered = Array.from(names).filter(n => !UNTOGGLEABLE_TOOLS.has(n))
  return updateSettingsForSource(source, {
    ...prev,
    disabledTools: filtered,
  })
}

export function ToolsPicker({ onExit }: Props): React.ReactNode {
  const [mode, setMode] = useState<Mode>('picking')
  const [flash, setFlash] = useState<string | null>(null)
  const sessionDisabled = useAppState(s => s.disabledTools)
  const setAppState = useSetAppState()

  // Build row list once per render from the static registry.
  const rows: Row[] = useMemo(() => {
    const globalPersisted = readPersistedDisabled('userSettings')
    const projectPersisted = readPersistedDisabled('projectSettings')
    return getAllBaseTools()
      .map(t => ({
        name: t.name,
        isUntoggleable: UNTOGGLEABLE_TOOLS.has(t.name),
        disabledGlobal: globalPersisted.has(t.name),
        disabledProject: projectPersisted.has(t.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [cursor, setCursor] = useState(0)
  // Working set — copy of session disabled, mutated by space key; applied on Enter/p/g.
  const [working, setWorking] = useState<Set<string>>(
    () => new Set(sessionDisabled),
  )

  useInput((input, key) => {
    if (mode !== 'picking') return

    if (key.escape) {
      onExit('已取消（未變更）')
      return
    }

    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(rows.length - 1, c + 1))
      return
    }

    if (input === ' ') {
      const row = rows[cursor]
      if (!row || row.isUntoggleable) return
      const next = new Set(working)
      if (next.has(row.name)) next.delete(row.name)
      else next.add(row.name)
      setWorking(next)
      return
    }

    // Enter = apply session-only
    if (key.return) {
      setAppState(prev => ({ ...prev, disabledTools: new Set(working) }))
      setMode('done')
      const disabledList = Array.from(working).sort()
      const summary =
        disabledList.length === 0
          ? '本 session 已啟用所有工具。'
          : `本 session：已停用 ${disabledList.length} 個工具 — ${disabledList.join(', ')}`
      onExit(summary)
      return
    }

    // p = save project
    if (input === 'p') {
      setAppState(prev => ({ ...prev, disabledTools: new Set(working) }))
      const { error } = writePersistedDisabled('projectSettings', working)
      setMode('done')
      if (error) {
        onExit(
          `僅 session 套用；寫入 project 設定失敗：${error.message}`,
        )
      } else {
        onExit(
          `已寫入 project 設定 (~/.my-agent/projects/...)：停用 ${working.size} 個工具`,
        )
      }
      return
    }

    // g = save global
    if (input === 'g') {
      setAppState(prev => ({ ...prev, disabledTools: new Set(working) }))
      const { error } = writePersistedDisabled('userSettings', working)
      setMode('done')
      if (error) {
        onExit(`僅 session 套用；寫入 global 設定失敗：${error.message}`)
      } else {
        onExit(
          `已寫入 global 設定 (~/.my-agent/settings.json)：停用 ${working.size} 個工具`,
        )
      }
      return
    }

    // r = reset (clear session + both persistent layers)
    if (input === 'r') {
      setWorking(new Set())
      setAppState(prev => ({ ...prev, disabledTools: new Set() }))
      const err1 = writePersistedDisabled('projectSettings', new Set()).error
      const err2 = writePersistedDisabled('userSettings', new Set()).error
      setFlash(
        err1 || err2
          ? `已重置：session 已清空；project=${err1 ? 'ERR' : 'ok'} global=${err2 ? 'ERR' : 'ok'}`
          : '已重置：session、project、global 全部清空，所有工具皆啟用。',
      )
      return
    }
  })

  if (mode === 'done') return null

  const enabledCount = rows.filter(
    r => r.isUntoggleable || !working.has(r.name),
  ).length
  const disabledCount = working.size

  return (
    <Box flexDirection="column" gap={0}>
      <Box>
        <Text bold>工具</Text>
        <Text dimColor>
          {' '}
          · 啟用 {enabledCount} / 停用 {disabledCount}
        </Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor
          const isDisabled = working.has(row.name)
          const mark = row.isUntoggleable
            ? '[ ]'
            : isDisabled
              ? '[✗]'
              : '[✓]'
          const color = row.isUntoggleable
            ? 'gray'
            : isDisabled
              ? 'red'
              : 'green'
          const tags: string[] = []
          if (row.isUntoggleable) tags.push('核心，鎖定')
          if (row.disabledProject) tags.push('project')
          if (row.disabledGlobal) tags.push('global')
          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : ''
          return (
            <Box key={row.name}>
              <Text color={selected ? 'cyan' : undefined}>
                {selected ? figures.pointer : ' '}
              </Text>
              <Text color={color}> {mark} </Text>
              <Text color={selected ? 'cyan' : undefined}>{row.name}</Text>
              <Text dimColor>{tagStr}</Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ 移動 · space 切換 · Enter 套用 session · p 存到 project · g 存到
          global · r 全部重置 · Esc 取消
        </Text>
      </Box>
      {flash && (
        <Box>
          <Text color="yellow">{flash}</Text>
        </Box>
      )}
    </Box>
  )
}
