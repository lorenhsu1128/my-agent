// Cron create/edit wizard with inline field editing.
//
// Original (Wave 3): display-only summary card — daemon sends an LLM-inferred
// draft, user confirms / cancels. Enter = confirm, Esc = cancel.
//
// Extended (Wave 4, Q3=b): user can press `E` to enter selection mode, pick
// a field, edit it, then back out and Enter-confirm. Also used by /cron
// slash command (commit 5) with an empty draft for human-authored creation.
//
// Public API (wizardId / draft / onConfirm / onCancel) unchanged so existing
// daemon LLM-gate call sites (src/screens/REPL.tsx) work without modification.
// onConfirm receives the *working* draft (possibly edited).

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'

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

type Mode = 'view' | 'selecting' | 'editing'

type FieldKind = 'string' | 'boolean' | 'number' | 'json'

type FieldDef = {
  key: string
  label: string
  kind: FieldKind
  advanced?: boolean
  /** Getter reads from the draft; returns display string + parsed value. */
  get: (d: CronWizardDraft) => unknown
  /** Setter merges value into draft (mutates clone, returns new draft). */
  set: (d: CronWizardDraft, value: unknown) => CronWizardDraft
}

// Field order matters — follows summary card layout.
const FIELDS: FieldDef[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    get: d => d.name,
    set: (d, v) => ({ ...d, name: typeof v === 'string' ? v : undefined }),
  },
  {
    key: 'cron',
    label: 'Schedule',
    kind: 'string',
    get: d => d.cron ?? d.schedule,
    set: (d, v) => ({ ...d, cron: typeof v === 'string' ? v : undefined }),
  },
  {
    key: 'prompt',
    label: 'Prompt',
    kind: 'string',
    get: d => d.prompt,
    set: (d, v) => ({ ...d, prompt: typeof v === 'string' ? v : undefined }),
  },
  {
    key: 'recurring',
    label: 'Recurring',
    kind: 'boolean',
    get: d => d.recurring,
    set: (d, v) => ({ ...d, recurring: Boolean(v) }),
  },
  {
    key: 'retry',
    label: 'Retry',
    kind: 'json',
    advanced: true,
    get: d => d.retry,
    set: (d, v) => ({ ...d, retry: v }),
  },
  {
    key: 'condition',
    label: 'Condition',
    kind: 'json',
    advanced: true,
    get: d => d.condition,
    set: (d, v) => ({ ...d, condition: v }),
  },
  {
    key: 'catchupMax',
    label: 'Catch-up max',
    kind: 'number',
    advanced: true,
    get: d => d.catchupMax,
    set: (d, v) => ({
      ...d,
      catchupMax: typeof v === 'number' ? v : undefined,
    }),
  },
  {
    key: 'notify',
    label: 'Notify',
    kind: 'json',
    advanced: true,
    get: d => d.notify,
    set: (d, v) => ({ ...d, notify: v }),
  },
  {
    key: 'preRunScript',
    label: 'Pre-run',
    kind: 'string',
    advanced: true,
    get: d => d.preRunScript,
    set: (d, v) => ({
      ...d,
      preRunScript: typeof v === 'string' && v !== '' ? v : undefined,
    }),
  },
  {
    key: 'modelOverride',
    label: 'Model',
    kind: 'string',
    advanced: true,
    get: d => d.modelOverride,
    set: (d, v) => ({
      ...d,
      modelOverride: typeof v === 'string' && v !== '' ? v : undefined,
    }),
  },
]

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

/** Serialize a field value back to text for the editor buffer. */
function toEditBuffer(v: unknown, kind: FieldKind): string {
  if (v === undefined || v === null) return ''
  if (kind === 'string') return String(v)
  if (kind === 'number') return typeof v === 'number' ? String(v) : ''
  if (kind === 'boolean') return v ? 'true' : 'false'
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return ''
  }
}

/** Parse edit buffer back into a typed value. Returns {ok,value} or {ok:false,error}. */
function parseEditBuffer(
  buf: string,
  kind: FieldKind,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = buf.trim()
  if (kind === 'string') {
    return { ok: true, value: trimmed === '' ? undefined : buf }
  }
  if (kind === 'number') {
    if (trimmed === '') return { ok: true, value: undefined }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return { ok: false, error: 'not a number' }
    return { ok: true, value: n }
  }
  if (kind === 'boolean') {
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') {
      return { ok: true, value: true }
    }
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') {
      return { ok: true, value: false }
    }
    return { ok: false, error: 'expected true / false' }
  }
  // json
  if (trimmed === '') return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (err) {
    return { ok: false, error: `JSON: ${(err as Error).message}` }
  }
}

export function CronCreateWizard(
  props: CronCreateWizardProps,
): React.ReactElement {
  const { draft: initialDraft, onConfirm, onCancel } = props

  const [working, setWorking] = useState<CronWizardDraft>(initialDraft)
  const [mode, setMode] = useState<Mode>('view')
  const [showAdvanced, setShowAdvanced] = useState<boolean>(() => {
    // If initial draft already has any advanced field set, default to showing.
    return FIELDS.filter(f => f.advanced).some(
      f => initialDraft[f.key] !== undefined,
    )
  })
  const [cursor, setCursor] = useState(0)
  const [editBuffer, setEditBuffer] = useState('')
  const [editCursor, setEditCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const visibleFields = useMemo(
    () => FIELDS.filter(f => showAdvanced || !f.advanced),
    [showAdvanced],
  )

  // Keep cursor in range when toggling advanced.
  useEffect(() => {
    if (cursor >= visibleFields.length) setCursor(visibleFields.length - 1)
  }, [visibleFields.length, cursor])

  useInput((input, key) => {
    if (mode === 'view') {
      if (key.return) {
        onConfirm(working)
        return
      }
      if (key.escape) {
        onCancel('user-cancel')
        return
      }
      if (input === 'E' || input === 'e') {
        setMode('selecting')
        setError(null)
        return
      }
      if (input === 'a' || input === 'A') {
        setShowAdvanced(v => !v)
        return
      }
      return
    }

    if (mode === 'selecting') {
      if (key.escape) {
        setMode('view')
        setError(null)
        return
      }
      if (input === 'a' || input === 'A') {
        setShowAdvanced(v => !v)
        return
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1))
        return
      }
      if (key.downArrow) {
        setCursor(c => Math.min(visibleFields.length - 1, c + 1))
        return
      }
      if (input === ' ') {
        const field = visibleFields[cursor]
        if (field?.kind === 'boolean') {
          const cur = field.get(working)
          setWorking(d => field.set(d, !cur))
        }
        return
      }
      if (key.return) {
        const field = visibleFields[cursor]
        if (!field) return
        if (field.kind === 'boolean') {
          const cur = field.get(working)
          setWorking(d => field.set(d, !cur))
          return
        }
        setEditBuffer(toEditBuffer(field.get(working), field.kind))
        setEditCursor(toEditBuffer(field.get(working), field.kind).length)
        setMode('editing')
        setError(null)
        return
      }
      return
    }

    // mode === 'editing': TextInput captures most keys via focus. We only
    // handle Esc here (TextInput does not expose onEsc).
    if (key.escape) {
      setMode('selecting')
      setError(null)
      return
    }
  })

  const submitEdit = (): void => {
    const field = visibleFields[cursor]
    if (!field) return
    const parsed = parseEditBuffer(editBuffer, field.kind)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setWorking(d => field.set(d, parsed.value))
    setError(null)
    setMode('selecting')
  }

  const hasAdvanced = FIELDS.some(f => f.advanced && working[f.key] !== undefined)

  const fieldRow = (
    field: FieldDef,
    index: number,
  ): React.ReactElement => {
    const active = mode !== 'view' && index === cursor
    const editing = active && mode === 'editing'
    return (
      <Box key={field.key}>
        <Box width={2}>
          <Text color={active ? 'cyan' : undefined}>{active ? '>' : ' '}</Text>
        </Box>
        <Box width={14}>
          <Text
            dimColor={!active}
            color={active ? 'cyan' : undefined}
          >
            {field.label}
          </Text>
        </Box>
        {editing ? (
          <Box flexGrow={1}>
            <TextInput
              value={editBuffer}
              onChange={setEditBuffer}
              onSubmit={submitEdit}
              cursorOffset={editCursor}
              onChangeCursorOffset={setEditCursor}
              columns={80}
              focus
              showCursor
              placeholder={
                field.kind === 'json' ? 'JSON or empty to clear' : ''
              }
            />
          </Box>
        ) : (
          <Text color={active ? 'cyan' : undefined}>
            {fmt(field.get(working))}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={mode === 'view' ? 'cyan' : 'yellow'}
      paddingX={1}
    >
      <Box>
        <Text bold color={mode === 'view' ? 'cyan' : 'yellow'}>
          {mode === 'view'
            ? 'Cron Task — confirm or cancel'
            : mode === 'selecting'
              ? 'Edit fields — select one to edit'
              : `Editing ${visibleFields[cursor]?.label ?? ''}`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {visibleFields
          .filter(f => !f.advanced)
          .map((f, i) => fieldRow(f, i))}
        {working.scheduleSpec?.raw ? (
          <Box>
            <Box width={2} />
            <Box width={14}>
              <Text dimColor>  raw</Text>
            </Box>
            <Text dimColor>{working.scheduleSpec.raw}</Text>
          </Box>
        ) : null}
      </Box>

      {(showAdvanced || hasAdvanced) && (
        <>
          <Box marginTop={1}>
            <Text dimColor>── Advanced ──────────────────</Text>
          </Box>
          <Box flexDirection="column">
            {visibleFields
              .filter(f => f.advanced)
              .map((f, i) => {
                // Recompute global index since cursor is over visibleFields
                const globalIndex = visibleFields.indexOf(f)
                return fieldRow(f, globalIndex)
              })}
            {!showAdvanced && (
              <Text dimColor>(press `a` to edit advanced fields)</Text>
            )}
          </Box>
        </>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {mode === 'view'
            ? `[Enter] Confirm  [Esc] Cancel  [E] Edit fields  [a] ${showAdvanced ? 'hide' : 'show'} advanced`
            : mode === 'selecting'
              ? '↑/↓ select  [Enter] edit / toggle  [Space] toggle bool  [a] adv  [Esc] back'
              : '[Enter] commit  [Esc] abort'}
        </Text>
      </Box>
    </Box>
  )
}
