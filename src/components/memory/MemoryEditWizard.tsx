// M-MEMTUI-2-1：Memory frontmatter / body inline wizard。
// Mirror CronCreateWizard 的多 mode pattern：view / selecting / editing /
// editing-body / editing-type。type 走 4 選 selector。
//
// 用於 auto-memory create / edit 與 local-config create / edit；
// USER / project / daily-log 不經此 wizard（body 編輯走 Shift+E spawn $EDITOR）。

import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  MEMORY_TYPES,
  type MemoryType,
} from '../../memdir/memoryTypes.js'

export type WizardKind = 'auto-memory' | 'local-config'

export type WizardDraft = {
  /** 是否新建（true → filename 可編；false → filename 鎖死） */
  isCreate: boolean
  /** 適用 kind，決定有無 frontmatter 欄位 */
  kind: WizardKind
  filename: string
  /** auto-memory 才有；local-config 設空字串並隱藏 */
  name: string
  description: string
  type: MemoryType
  body: string
}

type Mode =
  | 'view'
  | 'selecting'
  | 'editing'
  | 'editing-body'
  | 'editing-type'

type FieldId = 'filename' | 'name' | 'description' | 'type' | 'body'

type Props = {
  initial: WizardDraft
  /** Wizard 標題（master picker 傳入，例如 'New auto-memory' / 'Edit foo.md'） */
  title: string
  onSubmit: (draft: WizardDraft) => void
  onCancel: () => void
}

function visibleFields(draft: WizardDraft): FieldId[] {
  if (draft.kind === 'auto-memory') {
    return ['filename', 'name', 'description', 'type', 'body']
  }
  // local-config：無 frontmatter 規範，只 filename + body
  return ['filename', 'body']
}

function fieldLabel(f: FieldId): string {
  switch (f) {
    case 'filename':
      return 'filename'
    case 'name':
      return 'name'
    case 'description':
      return 'description'
    case 'type':
      return 'type'
    case 'body':
      return 'body'
  }
}

function fieldValue(d: WizardDraft, f: FieldId): string {
  switch (f) {
    case 'filename':
      return d.filename
    case 'name':
      return d.name
    case 'description':
      return d.description
    case 'type':
      return d.type
    case 'body':
      // 顯示 body 摘要（首行 + 行數）
      if (!d.body) return '(empty)'
      const firstLine = d.body.split('\n')[0] ?? ''
      const lines = d.body.split('\n').length
      const head = firstLine.length > 40 ? firstLine.slice(0, 37) + '...' : firstLine
      return lines > 1 ? `${head}  (${lines} lines)` : head
  }
}

export function MemoryEditWizard({
  initial,
  title,
  onSubmit,
  onCancel,
}: Props): React.ReactNode {
  const [draft, setDraft] = useState<WizardDraft>(initial)
  const [mode, setMode] = useState<Mode>('view')
  const [cursor, setCursor] = useState(0)
  const [buffer, setBuffer] = useState<string>('')
  const [typeIdx, setTypeIdx] = useState<number>(MEMORY_TYPES.indexOf(initial.type))
  const [error, setError] = useState<string | null>(null)

  const fields = visibleFields(draft)
  const filenameLocked = !draft.isCreate
  const safeCursor = Math.min(cursor, fields.length - 1)

  function startEditing(field: FieldId): void {
    if (field === 'filename' && filenameLocked) {
      setError('filename 鎖死（編輯模式）；用 r 重命名')
      return
    }
    if (field === 'type') {
      setTypeIdx(Math.max(0, MEMORY_TYPES.indexOf(draft.type)))
      setMode('editing-type')
      return
    }
    if (field === 'body') {
      setBuffer(draft.body)
      setMode('editing-body')
      return
    }
    setBuffer(fieldValue(draft, field))
    setMode('editing')
  }

  function commitEditing(): void {
    const f = fields[safeCursor]!
    if (f === 'filename') {
      const trimmed = buffer.trim()
      if (!trimmed.endsWith('.md')) {
        setError('filename 必須以 .md 結尾')
        return
      }
      setDraft(d => ({ ...d, filename: trimmed }))
    } else if (f === 'name') {
      setDraft(d => ({ ...d, name: buffer.trim() }))
    } else if (f === 'description') {
      setDraft(d => ({ ...d, description: buffer.trim() }))
    }
    setBuffer('')
    setError(null)
    setMode('selecting')
  }

  function commitBody(): void {
    setDraft(d => ({ ...d, body: buffer }))
    setBuffer('')
    setError(null)
    setMode('selecting')
  }

  function commitType(): void {
    const t = MEMORY_TYPES[typeIdx]
    if (t) setDraft(d => ({ ...d, type: t }))
    setError(null)
    setMode('selecting')
  }

  useInput((input, key) => {
    setError(null)

    if (mode === 'editing-type') {
      if (key.escape) {
        setMode('selecting')
        return
      }
      if (key.upArrow) {
        setTypeIdx(i => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setTypeIdx(i => Math.min(MEMORY_TYPES.length - 1, i + 1))
        return
      }
      if (key.return || input === ' ') {
        commitType()
        return
      }
      return
    }

    if (mode === 'editing-body') {
      if (key.escape) {
        setBuffer('')
        setMode('selecting')
        return
      }
      // Ctrl-S 或 F2 提交
      if (key.return && key.shift) {
        // Shift+Enter 在某些終端傳不來；用 \\<Enter> 慣例同 cron prompt editor
        commitBody()
        return
      }
      if (key.backspace || key.delete) {
        setBuffer(b => b.slice(0, -1))
        return
      }
      // 直接打字累積；換行用 backslash convention（與 cron prompt editor 一致）
      if (key.return) {
        // 偵測是否最後一字為 backslash → 改成 newline
        if (buffer.endsWith('\\')) {
          setBuffer(b => b.slice(0, -1) + '\n')
        } else {
          // Enter 不接 backslash 視為提交
          commitBody()
        }
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setBuffer(b => b + input)
        return
      }
      return
    }

    if (mode === 'editing') {
      if (key.escape) {
        setBuffer('')
        setMode('selecting')
        return
      }
      if (key.return) {
        commitEditing()
        return
      }
      if (key.backspace || key.delete) {
        setBuffer(b => b.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setBuffer(b => b + input)
        return
      }
      return
    }

    if (mode === 'selecting') {
      if (key.escape) {
        setMode('view')
        return
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1))
        return
      }
      if (key.downArrow) {
        setCursor(c => Math.min(fields.length - 1, c + 1))
        return
      }
      if (key.return || input === ' ') {
        startEditing(fields[safeCursor]!)
        return
      }
      return
    }

    // view mode
    if (key.escape || input === 'q') {
      onCancel()
      return
    }
    if (key.return) {
      // 確認送出 — 必填欄位檢查
      if (draft.isCreate && draft.kind === 'auto-memory') {
        if (!draft.filename.endsWith('.md')) {
          setError('filename 必須以 .md 結尾')
          return
        }
        if (!draft.name.trim()) {
          setError('name 不可空')
          return
        }
        if (!draft.description.trim()) {
          setError('description 不可空')
          return
        }
      }
      if (draft.isCreate && draft.kind === 'local-config') {
        if (!draft.filename.endsWith('.md')) {
          setError('filename 必須以 .md 結尾')
          return
        }
      }
      onSubmit(draft)
      return
    }
    if (input === 'E' || input === 'e') {
      setMode('selecting')
      return
    }
  })

  // ---------- Render ----------

  if (mode === 'editing-type') {
    return (
      <Box flexDirection="column">
        <Text bold>選擇 type</Text>
        {MEMORY_TYPES.map((t, i) => (
          <Box key={t}>
            <Text color={i === typeIdx ? 'cyan' : undefined}>
              {i === typeIdx ? figures.pointer : ' '} {t}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ 選 · Enter 確認 · Esc 取消</Text>
        </Box>
      </Box>
    )
  }

  if (mode === 'editing-body') {
    return (
      <Box flexDirection="column">
        <Text bold>編輯 body</Text>
        <Text dimColor>（行尾 `\` 後 Enter 換行；單獨 Enter = 提交；Esc 取消）</Text>
        <Box flexDirection="column" marginTop={1}>
          {(buffer + '_').split('\n').map((line, i) => (
            <Text key={i}>{line || ' '}</Text>
          ))}
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    )
  }

  if (mode === 'editing') {
    const f = fields[safeCursor]!
    return (
      <Box flexDirection="column">
        <Text bold>編輯 {fieldLabel(f)}</Text>
        <Box>
          <Text>{buffer}</Text>
          <Text color="cyan">_</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter 提交 · Esc 取消</Text>
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    )
  }

  // view / selecting 共用
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((f, i) => {
          const isCur = mode === 'selecting' && i === safeCursor
          return (
            <Box key={f}>
              <Text color={isCur ? 'cyan' : undefined}>
                {isCur ? figures.pointer : ' '}
              </Text>
              <Text dimColor> {fieldLabel(f).padEnd(12)}</Text>
              <Text>{fieldValue(draft, f)}</Text>
              {f === 'filename' && filenameLocked && (
                <Text dimColor>  (locked, 用 r 重命名)</Text>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        {mode === 'view' ? (
          <Text dimColor>
            Enter 送出 · E 編輯欄位 · q/Esc 取消
          </Text>
        ) : (
          <Text dimColor>
            ↑/↓ · Enter/Space 編此欄 · Esc 回 view
          </Text>
        )}
      </Box>
      {error && <Text color="red">{error}</Text>}
    </Box>
  )
}
