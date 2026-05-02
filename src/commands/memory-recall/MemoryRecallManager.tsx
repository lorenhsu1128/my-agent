// M-MEMRECALL-CMD：`/memory-recall` 主面板。
// 兩段式 UI：上方 settings header（read+toggle）、下方 session recall history。
// edit / delete 直接複用既有 `/memory` 的 memoryMutations.ts API。
// 鍵位設計與 /memory MemoryManager 對齊（↑↓ 導航、e edit、d delete、r rename、s settings、Esc exit）。

import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { applySettingsChange } from '../../utils/settings/applySettingsChange.js'
import { useSetAppState } from '../../state/AppState.js'
import {
  listRecall,
  type RecallLogEntry,
} from '../../memdir/sessionRecallLog.js'
import {
  listAllMemoryEntries,
  type MemoryEntry,
} from '../../utils/memoryList.js'
import { deleteEntry, type MutationResult } from '../memory/memoryMutations.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { readFileSync } from 'fs'
import {
  filterRecall,
  formatRow,
  NUMBER_RANGE,
  type RecallMode,
  type SettingsField,
} from './memoryRecallLogic.js'
import { readMemoryRecallSettings } from '../../memdir/findRelevantMemories.js'

type Props = { onExit: (summary: string) => void }
type Flash = { text: string; tone: 'info' | 'error' }

const ROW_LIMIT_PREVIEW = 12

function readEnabled(): boolean {
  const v = getInitialSettings().autoMemoryEnabled
  return typeof v === 'boolean' ? v : true
}

function writeMemoryRecallField(patch: {
  maxFiles?: number
  fallbackMaxFiles?: number
}): void {
  updateSettingsForSource('userSettings', {
    memoryRecall: patch,
  } as Parameters<typeof updateSettingsForSource>[1])
}

function writeEnabled(next: boolean): void {
  updateSettingsForSource('userSettings', {
    autoMemoryEnabled: next,
  } as Parameters<typeof updateSettingsForSource>[1])
}

export function MemoryRecallManager({ onExit }: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const sessionId = getSessionId()
  const setAppState = useSetAppState()

  const [mode, setMode] = useState<RecallMode>('list')
  const [flash, setFlash] = useState<Flash | null>(null)
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const [, setTick] = useState(0)
  const refresh = () => setTick(t => t + 1)

  // Settings 焦點與編輯狀態
  const [settingsField, setSettingsField] = useState<SettingsField>('enabled')
  const [editing, setEditing] = useState(false)

  // 拉資料
  const settings = readMemoryRecallSettings()
  const enabled = readEnabled()
  const allRecall = useMemo<RecallLogEntry[]>(
    () => listRecall(sessionId),
    [sessionId, mode, flash],
  )
  const filtered = useMemo(
    () => filterRecall(allRecall, filter),
    [allRecall, filter],
  )

  // cursor clamp
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1))
  }, [filtered.length, cursor])

  // Memory entries 索引：用 absolutePath → MemoryEntry，給 edit/delete 用
  const entryByPath = useMemo(() => {
    const m = new Map<string, MemoryEntry>()
    try {
      for (const e of listAllMemoryEntries(cwd)) m.set(e.absolutePath, e)
    } catch {
      /* ignore — listing 失敗時面板仍顯示 recall log，只是 edit/delete 不能用 */
    }
    return m
  }, [cwd, mode, flash])

  // ─── Mutation helpers ──────────────────────────────────────────────────
  const flashResult = (r: MutationResult, okText: string) => {
    if (r.ok) setFlash({ text: okText, tone: 'info' })
    else setFlash({ text: r.error ?? '操作失敗', tone: 'error' })
    refresh()
  }

  const handleDelete = (entry: RecallLogEntry) => {
    const me = entryByPath.get(entry.path)
    if (!me) {
      setFlash({ text: '找不到對應 memory entry（可能已被刪除）', tone: 'error' })
      setMode('list')
      return
    }
    const r = deleteEntry(cwd, me)
    flashResult(r, `軟刪 ${me.displayName} 到 .trash/`)
    setMode('list')
  }

  const handleEditBody = (entry: RecallLogEntry) => {
    const me = entryByPath.get(entry.path)
    if (!me) {
      setFlash({ text: '找不到對應 memory entry', tone: 'error' })
      return
    }
    try {
      const body = readFileSync(me.absolutePath, 'utf-8')
      const next = editFileInEditor(body)
      if (next !== null && next !== body) {
        // 寫回（簡單 raw write — 不動 frontmatter）
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs')
        fs.writeFileSync(me.absolutePath, next)
        setFlash({ text: `已編輯 ${me.displayName}`, tone: 'info' })
      } else {
        setFlash({ text: '已取消編輯', tone: 'info' })
      }
    } catch (e) {
      setFlash({ text: `編輯失敗：${(e as Error).message}`, tone: 'error' })
    }
    refresh()
  }

  // ─── Input handler ─────────────────────────────────────────────────────
  useInput((input, key) => {
    // 編輯數字時，TextInput 自己拿輸入
    if (editing) return

    // ── Settings 模式 ──
    if (mode === 'settings') {
      if (key.escape || input === 'q') {
        setMode('list')
        return
      }
      if (key.upArrow || input === 'k') {
        setSettingsField(f =>
          f === 'enabled'
            ? 'fallbackMaxFiles'
            : f === 'maxFiles'
              ? 'enabled'
              : 'maxFiles',
        )
        return
      }
      if (key.downArrow || input === 'j') {
        setSettingsField(f =>
          f === 'enabled'
            ? 'maxFiles'
            : f === 'maxFiles'
              ? 'fallbackMaxFiles'
              : 'enabled',
        )
        return
      }
      if (input === ' ' && settingsField === 'enabled') {
        writeEnabled(!enabled)
        applySettingsChange('userSettings', setAppState)
        setFlash({ text: `auto-memory 已${!enabled ? '啟用' : '停用'}`, tone: 'info' })
        refresh()
        return
      }
      if (
        (key.return || input === 'e') &&
        (settingsField === 'maxFiles' || settingsField === 'fallbackMaxFiles')
      ) {
        setEditing(true)
        return
      }
      return
    }

    // ── Filter 模式 ──
    if (mode === 'list' && (input === '/' || input === '\\')) {
      // '/' 字元在某些 shell 走 input handler 路徑，用 setMode 的 inline 編輯
      // （這裡先簡化：直接清空 filter）
      setFilter('')
      return
    }

    // ── ConfirmDelete 模式 ──
    if (mode === 'confirmDelete') {
      if (key.escape || input === 'n' || input === 'N') {
        setMode('list')
        return
      }
      if (input === 'y' || input === 'Y') {
        const entry = filtered[cursor]
        if (entry) handleDelete(entry)
        return
      }
      return
    }

    // ── Detail 模式 ──
    if (mode === 'detail') {
      if (key.escape || input === 'q' || key.leftArrow) {
        setMode('list')
        return
      }
      const entry = filtered[cursor]
      if (entry && (input === 'e' || input === 'E')) {
        handleEditBody(entry)
        return
      }
      if (entry && input === 'd') {
        setMode('confirmDelete')
        return
      }
      return
    }

    // ── List 模式（預設）──
    if (key.escape || input === 'q') {
      onExit(`Memory recall 面板已關閉（本 session 共命中 ${allRecall.length} 個 memory）`)
      return
    }
    if (input === 's') {
      setMode('settings')
      return
    }
    if (key.upArrow || input === 'k') {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setCursor(c => Math.min(Math.max(0, filtered.length - 1), c + 1))
      return
    }
    if (key.return) {
      if (filtered.length > 0) setMode('detail')
      return
    }
    const entry = filtered[cursor]
    if (entry && (input === 'e' || input === 'E')) {
      handleEditBody(entry)
      return
    }
    if (entry && input === 'd') {
      setMode('confirmDelete')
      return
    }
  })

  // ─── Render ─────────────────────────────────────────────────────────────
  const settingsPath = getSettingsFilePathForSource('userSettings') ?? '(user settings)'
  const cur = filtered[cursor]

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Memory Recall</Text>
        <Text dimColor>{'  '}（{settingsPath}）</Text>
      </Box>

      {/* Settings header */}
      <Box flexDirection="column" marginBottom={1}>
        <SettingsRow
          label="Enabled"
          value={enabled ? '[✓]' : '[ ]'}
          isFocus={mode === 'settings' && settingsField === 'enabled'}
        />
        <NumberSettingsRow
          label="Max files"
          value={settings.maxFiles}
          isFocus={mode === 'settings' && settingsField === 'maxFiles'}
          isEditing={editing && settingsField === 'maxFiles'}
          onSubmit={n => {
            writeMemoryRecallField({ maxFiles: n })
            applySettingsChange('userSettings', setAppState)
            setEditing(false)
            setFlash({ text: `Max files = ${n}`, tone: 'info' })
            refresh()
          }}
          onCancel={() => setEditing(false)}
        />
        <NumberSettingsRow
          label="Fallback max"
          value={settings.fallbackMaxFiles}
          isFocus={mode === 'settings' && settingsField === 'fallbackMaxFiles'}
          isEditing={editing && settingsField === 'fallbackMaxFiles'}
          onSubmit={n => {
            writeMemoryRecallField({ fallbackMaxFiles: n })
            applySettingsChange('userSettings', setAppState)
            setEditing(false)
            setFlash({ text: `Fallback max = ${n}`, tone: 'info' })
            refresh()
          }}
          onCancel={() => setEditing(false)}
        />
      </Box>

      {/* Recall history list */}
      <Box marginBottom={1}>
        <Text dimColor>
          Session recall history ({filtered.length}
          {filter ? ` / ${allRecall.length} 篩選` : ''})
        </Text>
      </Box>
      {filtered.length === 0 && (
        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor>
            （本 session 尚無 memory 命中。下一輪 user query 會觸發 selector）
          </Text>
        </Box>
      )}
      {filtered.slice(0, ROW_LIMIT_PREVIEW).map((e, i) => {
        const isSel = i === cursor && mode === 'list'
        const cursorMark = isSel ? '▶ ' : '  '
        return (
          <Box key={e.path}>
            <Text color={isSel ? 'cyan' : undefined}>
              {cursorMark}
              {formatRow(e, 50)}
            </Text>
          </Box>
        )
      })}
      {filtered.length > ROW_LIMIT_PREVIEW && (
        <Box marginLeft={2}>
          <Text dimColor>
            ... 還有 {filtered.length - ROW_LIMIT_PREVIEW} 筆（按 / 篩選）
          </Text>
        </Box>
      )}

      {/* Detail mode body */}
      {mode === 'detail' && cur && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
          <Text bold>{cur.path}</Text>
          <Text dimColor>
            {cur.hitCount}× hits · source={cur.source} · 第一次 {new Date(cur.ts).toLocaleString()}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>e/E: edit body  d: delete  Esc: back</Text>
          </Box>
        </Box>
      )}

      {/* ConfirmDelete */}
      {mode === 'confirmDelete' && cur && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
          <Text>
            確定軟刪 <Text bold>{cur.path}</Text> 到 .trash/？
          </Text>
          <Text dimColor>y/Y 執行 · n/N/Esc 取消</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        {mode === 'list' && (
          <Text dimColor>
            ↑↓ navigate · Enter detail · e edit · d delete · s settings · Esc exit
          </Text>
        )}
        {mode === 'settings' && (
          <Text dimColor>
            ↑↓ field · Space toggle · Enter/e edit number · Esc back
          </Text>
        )}
      </Box>

      {flash && (
        <Box marginTop={1}>
          <Text color={flash.tone === 'error' ? 'red' : 'green'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────────

function SettingsRow({
  label,
  value,
  isFocus,
}: {
  label: string
  value: string
  isFocus: boolean
}): React.ReactNode {
  const cursor = isFocus ? '▶ ' : '  '
  return (
    <Box>
      <Text color={isFocus ? 'cyan' : undefined}>
        {cursor}
        {label.padEnd(14, ' ')} {value}
      </Text>
    </Box>
  )
}

function NumberSettingsRow({
  label,
  value,
  isFocus,
  isEditing,
  onSubmit,
  onCancel,
}: {
  label: string
  value: number
  isFocus: boolean
  isEditing: boolean
  onSubmit: (n: number) => void
  onCancel: () => void
}): React.ReactNode {
  const cursor = isFocus ? '▶ ' : '  '
  const [text, setText] = useState(String(value))
  const [offset, setOffset] = useState(text.length)

  // 進入編輯時重設 buffer
  useEffect(() => {
    if (isEditing) {
      setText(String(value))
      setOffset(String(value).length)
    }
  }, [isEditing, value])

  useInput((_input, key) => {
    if (isEditing && key.escape) onCancel()
  })

  return (
    <Box>
      <Text color={isFocus ? 'cyan' : undefined}>
        {cursor}
        {label.padEnd(14, ' ')}{' '}
      </Text>
      {isEditing ? (
        <TextInput
          value={text}
          onChange={setText}
          onSubmit={raw => {
            const n = Number(raw.trim())
            if (
              !Number.isFinite(n) ||
              n < NUMBER_RANGE.min ||
              n > NUMBER_RANGE.max
            ) {
              onCancel()
              return
            }
            onSubmit(Math.round(n))
          }}
          placeholder=""
          columns={6}
          cursorOffset={offset}
          onChangeCursorOffset={setOffset}
          focus
          showCursor
        />
      ) : (
        <Text color={isFocus ? 'cyan' : undefined}>
          {value}{'  '}({NUMBER_RANGE.min}-{NUMBER_RANGE.max})
        </Text>
      )}
    </Box>
  )
}
