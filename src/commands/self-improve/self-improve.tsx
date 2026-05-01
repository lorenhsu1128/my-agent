import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { applySettingsChange } from '../../utils/settings/applySettingsChange.js'
import { useSetAppState } from '../../state/AppState.js'
import {
  getSelfImproveThresholds,
  SELF_IMPROVE_DEFAULTS,
} from '../../services/selfImprove/thresholds.js'

type RowKind = 'bool' | 'number'

type Row =
  | {
      kind: 'bool'
      label: string
      // 讀取目前值
      get: () => boolean
      // 寫入新值（只負責呼叫 updateSettingsForSource，不負責 reload）
      set: (next: boolean) => void
    }
  | {
      kind: 'number'
      label: string
      unit: string
      defaultValue: number
      get: () => number
      set: (next: number) => void
    }

function readBoolFromSelfImprove(
  key:
    | 'skillCreationNudgeEnabled'
    | 'skillImprovementEnabled'
    | 'memoryNudgeEnabled'
    | 'sessionReviewEnabled',
): boolean {
  const v = getInitialSettings().selfImproveThresholds?.[key]
  return typeof v === 'boolean' ? v : true
}

function writeSelfImproveField(patch: Record<string, unknown>): void {
  updateSettingsForSource('userSettings', {
    selfImproveThresholds: patch,
  } as Parameters<typeof updateSettingsForSource>[1])
}

function buildRows(): Row[] {
  const t = getSelfImproveThresholds()
  return [
    {
      kind: 'bool',
      label: '① Skill Creation Nudge — 偵測「值得存成 skill」的工作流',
      get: () => readBoolFromSelfImprove('skillCreationNudgeEnabled'),
      set: next => writeSelfImproveField({ skillCreationNudgeEnabled: next }),
    },
    {
      kind: 'number',
      label: '   └ 觸發閾值（單次 query 工具使用次數 ≥）',
      unit: 'tool uses',
      defaultValue: SELF_IMPROVE_DEFAULTS.skillCreationToolUseThreshold,
      get: () => t.skillCreationToolUseThreshold,
      set: next =>
        writeSelfImproveField({ skillCreationToolUseThreshold: next }),
    },
    {
      kind: 'bool',
      label: '② Skill Improvement — 從修正中改進專案 skill',
      get: () => readBoolFromSelfImprove('skillImprovementEnabled'),
      set: next => writeSelfImproveField({ skillImprovementEnabled: next }),
    },
    {
      kind: 'number',
      label: '   └ 觸發閾值（user turns 批次大小）',
      unit: 'turns',
      defaultValue: SELF_IMPROVE_DEFAULTS.skillImprovementTurnBatch,
      get: () => t.skillImprovementTurnBatch,
      set: next => writeSelfImproveField({ skillImprovementTurnBatch: next }),
    },
    {
      kind: 'bool',
      label: '③ Memory Nudge — 提示儲存使用者偏好/修正',
      get: () => readBoolFromSelfImprove('memoryNudgeEnabled'),
      set: next => writeSelfImproveField({ memoryNudgeEnabled: next }),
    },
    {
      kind: 'number',
      label: '   └ 觸發閾值（user turns 批次大小）',
      unit: 'turns',
      defaultValue: SELF_IMPROVE_DEFAULTS.memoryNudgeTurnBatch,
      get: () => t.memoryNudgeTurnBatch,
      set: next => writeSelfImproveField({ memoryNudgeTurnBatch: next }),
    },
    {
      kind: 'bool',
      label: '④ Session Review — 長 session 中的 auto-memory 整理',
      get: () => readBoolFromSelfImprove('sessionReviewEnabled'),
      set: next => writeSelfImproveField({ sessionReviewEnabled: next }),
    },
    {
      kind: 'number',
      label: '   └ 最少 tool uses',
      unit: 'tool uses',
      defaultValue: SELF_IMPROVE_DEFAULTS.sessionReviewMinToolUses,
      get: () => t.sessionReviewMinToolUses,
      set: next => writeSelfImproveField({ sessionReviewMinToolUses: next }),
    },
    {
      kind: 'number',
      label: '   └ 最短間隔（小時）',
      unit: 'hours',
      defaultValue: SELF_IMPROVE_DEFAULTS.sessionReviewMinIntervalHours,
      get: () => t.sessionReviewMinIntervalHours,
      set: next =>
        writeSelfImproveField({ sessionReviewMinIntervalHours: next }),
    },
    {
      kind: 'bool',
      label: '⑤ Auto Dream — 背景記憶 consolidation',
      get: () => {
        const v = getInitialSettings().autoDreamEnabled
        return typeof v === 'boolean' ? v : true
      },
      set: next =>
        updateSettingsForSource('userSettings', { autoDreamEnabled: next }),
    },
    {
      kind: 'number',
      label: '   └ 最短間隔（小時）',
      unit: 'hours',
      defaultValue: SELF_IMPROVE_DEFAULTS.autoDreamMinHours,
      get: () => t.autoDreamMinHours,
      set: next => writeSelfImproveField({ autoDreamMinHours: next }),
    },
    {
      kind: 'number',
      label: '   └ 最少 session 數',
      unit: 'sessions',
      defaultValue: SELF_IMPROVE_DEFAULTS.autoDreamMinSessions,
      get: () => t.autoDreamMinSessions,
      set: next => writeSelfImproveField({ autoDreamMinSessions: next }),
    },
  ]
}

type Props = {
  onDone: LocalJSXCommandOnDone
}

function NumberEditor({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: number
  onSubmit: (next: number) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = useState(String(initial))
  const [cursorOffset, setCursorOffset] = useState(value.length)

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <TextInput
      value={value}
      onChange={setValue}
      onSubmit={raw => {
        const n = Number(raw.trim())
        if (!Number.isFinite(n) || n <= 0) {
          onCancel()
          return
        }
        onSubmit(n)
      }}
      placeholder=""
      columns={20}
      cursorOffset={cursorOffset}
      onChangeCursorOffset={setCursorOffset}
      focus
      showCursor
    />
  )
}

function SelfImprovePanel({ onDone }: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const [rows, setRows] = useState<Row[]>(() => buildRows())
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string>('')

  const refresh = () => setRows(buildRows())

  useInput((input, key) => {
    if (editing) return // TextInput owns input

    if (key.escape || input === 'q') {
      onDone('Self-improve 設定面板已關閉')
      return
    }

    if (key.upArrow || input === 'k') {
      setSelected(s => (s > 0 ? s - 1 : rows.length - 1))
      setStatusMsg('')
      return
    }

    if (key.downArrow || input === 'j') {
      setSelected(s => (s < rows.length - 1 ? s + 1 : 0))
      setStatusMsg('')
      return
    }

    const row = rows[selected]
    if (!row) return

    if (input === ' ' && row.kind === 'bool') {
      const next = !row.get()
      row.set(next)
      applySettingsChange('userSettings', setAppState)
      refresh()
      setStatusMsg(`✓ 已${next ? '啟用' : '停用'}`)
      return
    }

    if ((key.return || input === 'e') && row.kind === 'number') {
      setEditing(true)
      setStatusMsg('')
      return
    }
  })

  const row = rows[selected]
  const isNumberEditing = editing && row?.kind === 'number'

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Self-improve nudge 設定</Text>
        <Text dimColor>
          {'  '}（寫入 {getSettingsFilePathForSource('userSettings') ?? '(user settings)'}）
        </Text>
      </Box>

      {rows.map((r, i) => {
        const isSel = i === selected
        const cursor = isSel ? '▶ ' : '  '
        if (r.kind === 'bool') {
          const on = r.get()
          const icon = on ? '[✓]' : '[ ]'
          return (
            <Box key={i}>
              <Text color={isSel ? 'cyan' : undefined}>
                {cursor}
                {icon} {r.label}
              </Text>
            </Box>
          )
        }
        // number row
        const cur = r.get()
        const isDefault = cur === r.defaultValue
        const valueText = `${cur} ${r.unit}${isDefault ? ' (預設)' : ''}`
        return (
          <Box key={i}>
            <Text color={isSel ? 'cyan' : undefined}>
              {cursor}
              {r.label}: {' '}
            </Text>
            {isSel && isNumberEditing ? (
              <NumberEditor
                initial={cur}
                onSubmit={next => {
                  r.set(next)
                  applySettingsChange('userSettings', setAppState)
                  setEditing(false)
                  refresh()
                  setStatusMsg(`✓ 已更新為 ${next}`)
                }}
                onCancel={() => {
                  setEditing(false)
                  setStatusMsg('已取消編輯')
                }}
              />
            ) : (
              <Text color={isSel ? 'cyan' : undefined}>{valueText}</Text>
            )}
          </Box>
        )
      })}

      <Box marginTop={1} flexDirection="column">
        {statusMsg ? (
          <Text color="green">{statusMsg}</Text>
        ) : (
          <Text dimColor>
            ↑/↓ 選擇 · Space 切換開關 · Enter/e 編輯數值 · Esc/q 關閉
          </Text>
        )}
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  _args?: string,
): Promise<React.ReactNode> {
  return <SelfImprovePanel onDone={onDone} />
}
