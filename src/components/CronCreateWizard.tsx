// M-CRON-W3-8b：Cron create wizard summary card.
//
// 收到 daemon broadcast 的 cronCreateWizard frame 後彈出，把 LLM 推斷的完整
// task draft 列出來讓使用者確認 / 取消。本版採 summary card 模式（plan 對齊）：
// 一眼掃過 + Enter 確認 / Esc 取消。inline edit 留待後續 iteration。
//
// 多 client 第一個回應 wins（router 端做仲裁）；本元件收 'resolved' frame 時
// 由 parent 自動 unmount。

import React, { useEffect } from 'react'
import { Box, Text, useInput } from '../ink.js'

export type CronWizardDraft = {
  cron?: string
  schedule?: string
  prompt?: string
  name?: string
  recurring?: boolean
  durable?: boolean
  // Wave 3 advanced fields
  notify?: unknown
  retry?: unknown
  condition?: unknown
  catchupMax?: number
  history?: unknown
  preRunScript?: string
  modelOverride?: string
  scheduleSpec?: { kind: string; raw: string }
  [key: string]: unknown
}

export interface CronCreateWizardProps {
  wizardId: string
  draft: CronWizardDraft
  onConfirm: (task: CronWizardDraft) => void
  onCancel: (reason?: string) => void
}

function fieldRow(label: string, value: string): React.ReactElement {
  return (
    <Box>
      <Box width={14}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
}

function fmt(v: unknown, fallback = '(none)'): string {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? '✓ yes' : '✗ no'
  if (typeof v === 'number') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return fallback
  }
}

export function CronCreateWizard(
  props: CronCreateWizardProps,
): React.ReactElement {
  const { draft, onConfirm, onCancel } = props
  useInput((input, key) => {
    if (key.return) {
      onConfirm(draft)
    } else if (key.escape) {
      onCancel('user-cancel')
    }
  })

  // Auto-cancel safety: if process exits / unmounts unexpectedly we'd leak the
  // pending wizard server-side. Server has 5min timeout so this is defense
  // in depth only.
  useEffect(() => {
    return () => {
      // No-op on unmount; resolved broadcast from server tells unmounter.
    }
  }, [])

  const advanced =
    draft.notify !== undefined ||
    draft.retry !== undefined ||
    draft.condition !== undefined ||
    draft.catchupMax !== undefined ||
    draft.history !== undefined ||
    draft.preRunScript !== undefined

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        Create Cron Task — confirm or cancel
      </Text>
      <Box marginTop={1} flexDirection="column">
        {draft.name !== undefined && fieldRow('Name', fmt(draft.name))}
        {fieldRow('Schedule', fmt(draft.cron ?? draft.schedule))}
        {draft.scheduleSpec?.raw &&
          fieldRow('  raw', String(draft.scheduleSpec.raw))}
        {fieldRow('Prompt', fmt(draft.prompt))}
        {fieldRow(
          'Recurring',
          draft.recurring === undefined ? '(default)' : fmt(draft.recurring),
        )}
        {draft.durable !== undefined &&
          fieldRow('Durable', fmt(draft.durable))}
      </Box>
      {advanced && (
        <>
          <Box marginTop={1}>
            <Text dimColor>── Advanced ──────────────────</Text>
          </Box>
          <Box flexDirection="column">
            {draft.notify !== undefined && fieldRow('Notify', fmt(draft.notify))}
            {draft.retry !== undefined && fieldRow('Retry', fmt(draft.retry))}
            {draft.condition !== undefined &&
              fieldRow('Condition', fmt(draft.condition))}
            {draft.catchupMax !== undefined &&
              fieldRow('Catch-up max', fmt(draft.catchupMax))}
            {draft.history !== undefined &&
              fieldRow('History', fmt(draft.history))}
            {draft.preRunScript !== undefined &&
              fieldRow('Pre-run', fmt(draft.preRunScript))}
            {draft.modelOverride !== undefined &&
              fieldRow('Model', fmt(draft.modelOverride))}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          [Enter] Confirm    [Esc] Cancel
        </Text>
      </Box>
    </Box>
  )
}
