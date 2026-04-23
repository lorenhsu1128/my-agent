// Schedule editor — preset picker with parametric fills, custom cron escape
// hatch, and natural-language fallback. Launched by CronCreateWizard when the
// user edits the Schedule field. Decouples "picking a schedule" from "typing
// 5-field cron syntax" for non-power users.

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { nextCronRunMs } from '../utils/cronTasks.js'
import { parseScheduleNL } from '../utils/cronNlParser.js'
import { formatDuration } from '../utils/format.js'
import TextInput from './TextInput.js'

export type ScheduleEditorResult = {
  cron: string
  scheduleSpec: { kind: 'cron' | 'nl'; raw: string }
  recurring: boolean
}

export type CronScheduleEditorProps = {
  initial?: { cron?: string; raw?: string }
  onConfirm: (r: ScheduleEditorResult) => void
  onCancel: () => void
}

type PresetBase = { label: string; hint?: string }

type StaticPreset = PresetBase & {
  kind: 'static'
  cron: string
  recurring: boolean
}

type ParamPreset = PresetBase & {
  kind:
    | 'everyNHours'
    | 'dailyHHMM'
    | 'weeklyDHHMM'
    | 'weekdaysHHMM'
    | 'monthlyDHHMM'
    | 'oneshot'
    | 'custom'
    | 'nl'
}

type Preset = StaticPreset | ParamPreset

const PRESETS: Preset[] = [
  { kind: 'static', label: 'Every minute', cron: '* * * * *', recurring: true },
  { kind: 'static', label: 'Every 2 minutes', cron: '*/2 * * * *', recurring: true },
  { kind: 'static', label: 'Every 5 minutes', cron: '*/5 * * * *', recurring: true },
  { kind: 'static', label: 'Every 15 minutes', cron: '*/15 * * * *', recurring: true },
  { kind: 'static', label: 'Every 30 minutes', cron: '*/30 * * * *', recurring: true },
  { kind: 'static', label: 'Hourly (at :00)', cron: '0 * * * *', recurring: true },
  { kind: 'everyNHours', label: 'Every N hours (1,2,3,4,6,8,12)' },
  { kind: 'dailyHHMM', label: 'Daily at HH:MM' },
  { kind: 'weeklyDHHMM', label: 'Weekly on <day> at HH:MM' },
  { kind: 'weekdaysHHMM', label: 'Weekdays (Mon–Fri) at HH:MM' },
  { kind: 'monthlyDHHMM', label: 'Monthly on day N at HH:MM' },
  { kind: 'oneshot', label: 'One-shot at YYYY-MM-DD HH:MM' },
  { kind: 'custom', label: 'Custom 5-field cron' },
  { kind: 'nl', label: 'Natural language (LLM)' },
]

type Mode = 'list' | 'param' | 'custom' | 'nl'

/** Two-digit zero-padded int. */
function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Format a Date as "YYYY-MM-DD HH:MM" local time. */
function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Next-fire preview line for a valid cron, or null if it can't be evaluated. */
function previewLine(cron: string, now: number): string | null {
  const next = nextCronRunMs(cron, now)
  if (next === null) return null
  const delta = next - now
  const iso = new Date(next).toLocaleString()
  if (delta <= 0) return `${iso} (overdue)`
  return `${iso} (in ${formatDuration(delta, { mostSignificantOnly: true })})`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function CronScheduleEditor(
  props: CronScheduleEditorProps,
): React.ReactElement {
  const [mode, setMode] = useState<Mode>('list')
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // Param mode state
  const [paramKind, setParamKind] = useState<ParamPreset['kind'] | null>(null)
  const [fieldIdx, setFieldIdx] = useState(0)
  // Shared field values (use whichever the current param kind reads)
  const [nHours, setNHours] = useState('2')
  const [timeStr, setTimeStr] = useState('09:00')
  const [weekday, setWeekday] = useState(1) // 0=Sun, 6=Sat; default Monday
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [oneshotDate, setOneshotDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  })
  const [editingField, setEditingField] = useState(false)
  const [fieldBuffer, setFieldBuffer] = useState('')
  const [fieldCursor, setFieldCursor] = useState(0)

  // Custom / NL text
  const [customBuf, setCustomBuf] = useState(props.initial?.cron ?? '')
  const [customCursor, setCustomCursor] = useState(
    (props.initial?.cron ?? '').length,
  )
  const [nlBuf, setNlBuf] = useState(props.initial?.raw ?? '')
  const [nlCursor, setNlCursor] = useState((props.initial?.raw ?? '').length)
  const [nlBusy, setNlBusy] = useState(false)

  const [error, setError] = useState<string | null>(null)

  // Preview clock — tick every 10s.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  const selected = PRESETS[cursor]

  /** Compute cron string from current param mode + field values. Returns
   * `{cron, recurring}` or a string error. */
  function resolveParamPreset():
    | { ok: true; cron: string; recurring: boolean }
    | { ok: false; error: string } {
    if (paramKind === 'everyNHours') {
      const n = parseInt(nHours.trim(), 10)
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'N must be a positive integer' }
      if (24 % n !== 0) return { ok: false, error: 'N must divide 24 evenly (1, 2, 3, 4, 6, 8, 12)' }
      return { ok: true, cron: `0 */${n} * * *`, recurring: true }
    }
    if (paramKind === 'dailyHHMM' || paramKind === 'weekdaysHHMM' || paramKind === 'weeklyDHHMM' || paramKind === 'monthlyDHHMM' || paramKind === 'oneshot') {
      const tm = parseHHMM(timeStr)
      if (!tm) return { ok: false, error: 'Invalid time (expect HH:MM, 00:00 – 23:59)' }
      if (paramKind === 'dailyHHMM') {
        return { ok: true, cron: `${tm.m} ${tm.h} * * *`, recurring: true }
      }
      if (paramKind === 'weekdaysHHMM') {
        return { ok: true, cron: `${tm.m} ${tm.h} * * 1-5`, recurring: true }
      }
      if (paramKind === 'weeklyDHHMM') {
        return { ok: true, cron: `${tm.m} ${tm.h} * * ${weekday}`, recurring: true }
      }
      if (paramKind === 'monthlyDHHMM') {
        const dom = parseInt(dayOfMonth.trim(), 10)
        if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
          return { ok: false, error: 'Day of month must be 1-31' }
        }
        return { ok: true, cron: `${tm.m} ${tm.h} ${dom} * *`, recurring: true }
      }
      if (paramKind === 'oneshot') {
        const d = parseYMD(oneshotDate)
        if (!d) return { ok: false, error: 'Invalid date (expect YYYY-MM-DD)' }
        // Check target datetime is in the future.
        const target = new Date(d.year, d.month - 1, d.day, tm.h, tm.m, 0, 0)
        if (target.getTime() <= Date.now()) {
          return { ok: false, error: 'Date/time is in the past' }
        }
        return {
          ok: true,
          cron: `${tm.m} ${tm.h} ${d.day} ${d.month} *`,
          recurring: false,
        }
      }
    }
    return { ok: false, error: 'Unsupported preset' }
  }

  function commitStatic(p: StaticPreset): void {
    props.onConfirm({
      cron: p.cron,
      scheduleSpec: { kind: 'cron', raw: p.cron },
      recurring: p.recurring,
    })
  }

  function commitParam(): void {
    const r = resolveParamPreset()
    if (!r.ok) {
      setError(r.error)
      return
    }
    props.onConfirm({
      cron: r.cron,
      scheduleSpec: { kind: 'cron', raw: r.cron },
      recurring: r.recurring,
    })
  }

  function commitCustom(): void {
    const raw = customBuf.trim()
    if (!raw) {
      setError('Empty cron')
      return
    }
    const parts = raw.split(/\s+/)
    if (parts.length !== 5) {
      setError('Must be 5 space-separated fields')
      return
    }
    // nextCronRunMs returns null when the cron can never fire — basic
    // validator for free.
    const n = nextCronRunMs(raw, Date.now())
    if (n === null) {
      setError('Invalid cron — unreachable schedule')
      return
    }
    props.onConfirm({
      cron: raw,
      scheduleSpec: { kind: 'cron', raw },
      recurring: true,
    })
  }

  async function commitNL(): Promise<void> {
    const raw = nlBuf.trim()
    if (!raw) {
      setError('Empty text')
      return
    }
    setNlBusy(true)
    setError(null)
    try {
      const ctrl = new AbortController()
      const parsed = await parseScheduleNL(raw, { signal: ctrl.signal })
      props.onConfirm({
        cron: parsed.cron,
        scheduleSpec: { kind: 'nl', raw },
        recurring: parsed.recurring,
      })
    } catch (err) {
      setError(`LLM parse failed: ${(err as Error).message}`)
    } finally {
      setNlBusy(false)
    }
  }

  function enterPreset(p: Preset): void {
    setError(null)
    if (p.kind === 'static') {
      commitStatic(p)
      return
    }
    if (p.kind === 'custom') {
      setMode('custom')
      return
    }
    if (p.kind === 'nl') {
      setMode('nl')
      return
    }
    // Parametric
    setParamKind(p.kind)
    setFieldIdx(0)
    setEditingField(false)
    setMode('param')
  }

  // ── Input handling ─────────────────────────────────────────────────────
  useInput((input, key) => {
    if (mode === 'list') {
      if (key.escape) {
        props.onCancel()
        return
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1))
        return
      }
      if (key.downArrow) {
        setCursor(c => Math.min(PRESETS.length - 1, c + 1))
        return
      }
      if (key.return) {
        enterPreset(selected!)
        return
      }
      return
    }

    if (mode === 'custom') {
      if (key.escape && !editingField) {
        setMode('list')
        setError(null)
        return
      }
      return // TextInput owns input while focused
    }

    if (mode === 'nl') {
      if (key.escape && !nlBusy) {
        setMode('list')
        setError(null)
        return
      }
      return
    }

    if (mode === 'param') {
      if (editingField) {
        // TextInput handles; Esc aborts edit
        if (key.escape) {
          setEditingField(false)
          setError(null)
        }
        return
      }
      if (key.escape) {
        setMode('list')
        setError(null)
        setParamKind(null)
        return
      }
      const fields = paramFields(paramKind!)
      if (key.upArrow) {
        setFieldIdx(i => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setFieldIdx(i => Math.min(fields.length - 1, i + 1))
        return
      }
      if (key.return) {
        const f = fields[fieldIdx]
        if (!f) return
        if (f.kind === 'weekday') {
          // Space / Enter cycles
          setWeekday(w => (w + 1) % 7)
          return
        }
        // Enter text-input mode
        const cur =
          f.kind === 'N' ? nHours
          : f.kind === 'time' ? timeStr
          : f.kind === 'dom' ? dayOfMonth
          : f.kind === 'ymd' ? oneshotDate
          : ''
        setFieldBuffer(cur)
        setFieldCursor(cur.length)
        setEditingField(true)
        setError(null)
        return
      }
      if (input === ' ') {
        const f = fields[fieldIdx]
        if (f?.kind === 'weekday') setWeekday(w => (w + 1) % 7)
        return
      }
      if (input === 'c') {
        commitParam()
        return
      }
      return
    }
  })

  // ── Render ─────────────────────────────────────────────────────────────

  if (mode === 'list') {
    const live =
      selected?.kind === 'static'
        ? previewLine(selected.cron, now) ?? selected.cron
        : '(fill parameters on next screen)'
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          Pick a schedule
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {PRESETS.map((p, i) => {
            const active = i === cursor
            return (
              <Box key={p.label}>
                <Text color={active ? 'cyan' : undefined}>{active ? '>' : ' '} </Text>
                <Text color={active ? 'cyan' : undefined}>{p.label}</Text>
                {p.kind === 'static' && (
                  <Text dimColor> ({p.cron})</Text>
                )}
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>── Next fire preview ──</Text>
          <Text>{live}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · Enter = choose · Esc = cancel</Text>
        </Box>
      </Box>
    )
  }

  if (mode === 'custom') {
    const preview = customBuf.trim() ? previewLine(customBuf.trim(), now) : null
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">
          Custom 5-field cron
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Format: </Text>
          <Text>minute hour day-of-month month day-of-week</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <TextInput
            value={customBuf}
            onChange={setCustomBuf}
            onSubmit={commitCustom}
            cursorOffset={customCursor}
            onChangeCursorOffset={setCustomCursor}
            columns={60}
            focus
            showCursor
            placeholder="e.g. */15 * * * *"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>── Next fire preview ──</Text>
          <Text>{preview ?? '(enter a valid cron)'}</Text>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter = confirm · Esc = back</Text>
        </Box>
      </Box>
    )
  }

  if (mode === 'nl') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">
          Natural language schedule (LLM)
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            e.g. "每週一早上 9 點", "every 15 minutes", "weekdays at 8pm"
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <TextInput
            value={nlBuf}
            onChange={setNlBuf}
            onSubmit={() => void commitNL()}
            cursorOffset={nlCursor}
            onChangeCursorOffset={setNlCursor}
            columns={60}
            focus={!nlBusy}
            showCursor={!nlBusy}
          />
        </Box>
        {nlBusy && (
          <Box marginTop={1}>
            <Text color="yellow">Resolving via LLM…</Text>
          </Box>
        )}
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter = parse &amp; confirm · Esc = back</Text>
        </Box>
      </Box>
    )
  }

  // Param mode
  const fields = paramFields(paramKind!)
  const parRes = resolveParamPreset()
  const previewStr = parRes.ok ? previewLine(parRes.cron, now) : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {PRESETS.find(p => p.kind === paramKind)?.label}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {fields.map((f, i) => {
          const active = i === fieldIdx && !editingField
          const editing = i === fieldIdx && editingField
          const valueText =
            f.kind === 'N' ? nHours
            : f.kind === 'time' ? timeStr
            : f.kind === 'dom' ? dayOfMonth
            : f.kind === 'ymd' ? oneshotDate
            : f.kind === 'weekday' ? WEEKDAYS[weekday] ?? '?'
            : ''
          return (
            <Box key={f.key}>
              <Box width={2}>
                <Text color={active ? 'cyan' : undefined}>{active ? '>' : ' '}</Text>
              </Box>
              <Box width={18}>
                <Text color={active ? 'cyan' : undefined}>{f.label}</Text>
              </Box>
              {editing ? (
                <Box>
                  <TextInput
                    value={fieldBuffer}
                    onChange={setFieldBuffer}
                    onSubmit={v => {
                      // commit into the right state slot
                      if (f.kind === 'N') setNHours(v)
                      else if (f.kind === 'time') setTimeStr(v)
                      else if (f.kind === 'dom') setDayOfMonth(v)
                      else if (f.kind === 'ymd') setOneshotDate(v)
                      setEditingField(false)
                      setError(null)
                    }}
                    cursorOffset={fieldCursor}
                    onChangeCursorOffset={setFieldCursor}
                    columns={30}
                    focus
                    showCursor
                  />
                </Box>
              ) : (
                <Text>{valueText}</Text>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>── Next fire preview ──</Text>
        {parRes.ok ? (
          <Text>{previewStr ?? parRes.cron}</Text>
        ) : (
          <Text color="red">{parRes.error}</Text>
        )}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {editingField
            ? 'Enter = commit field · Esc = cancel field'
            : '↑/↓ field · Enter = edit / toggle · Space (weekday) cycle · c = confirm · Esc = back'}
        </Text>
      </Box>
    </Box>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────

type FieldDef = {
  key: string
  label: string
  kind: 'N' | 'time' | 'weekday' | 'dom' | 'ymd'
}

function paramFields(kind: ParamPreset['kind']): FieldDef[] {
  switch (kind) {
    case 'everyNHours':
      return [{ key: 'n', label: 'N hours', kind: 'N' }]
    case 'dailyHHMM':
      return [{ key: 'time', label: 'Time (HH:MM)', kind: 'time' }]
    case 'weeklyDHHMM':
      return [
        { key: 'weekday', label: 'Day of week', kind: 'weekday' },
        { key: 'time', label: 'Time (HH:MM)', kind: 'time' },
      ]
    case 'weekdaysHHMM':
      return [{ key: 'time', label: 'Time (HH:MM)', kind: 'time' }]
    case 'monthlyDHHMM':
      return [
        { key: 'dom', label: 'Day of month', kind: 'dom' },
        { key: 'time', label: 'Time (HH:MM)', kind: 'time' },
      ]
    case 'oneshot':
      return [
        { key: 'ymd', label: 'Date (YYYY-MM-DD)', kind: 'ymd' },
        { key: 'time', label: 'Time (HH:MM)', kind: 'time' },
      ]
    default:
      return []
  }
}

function parseHHMM(s: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!match) return null
  const h = parseInt(match[1]!, 10)
  const m = parseInt(match[2]!, 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

function parseYMD(s: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim())
  if (!match) return null
  const year = parseInt(match[1]!, 10)
  const month = parseInt(match[2]!, 10)
  const day = parseInt(match[3]!, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}
