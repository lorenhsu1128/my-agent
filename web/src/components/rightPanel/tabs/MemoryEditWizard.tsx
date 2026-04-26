/**
 * M-WEB-CLOSEOUT-5/6：Memory edit wizard
 *
 * 行為矩陣（mirror TUI MemoryEditWizard）：
 *   auto-memory      → name + description + type + body（全 frontmatter + body）
 *   user-profile     → body only（不顯 frontmatter 欄位）
 *   project-memory   → body only
 *   local-config     → body only（無 frontmatter）
 *   daily-log        → 唯讀，不應進 wizard（caller 守 gate）
 *
 *   create mode 只允許 auto-memory + local-config（kind dropdown 限制）
 *
 *   存檔前用 client-side `containsSecret` 提示，hit 時要求使用者勾「override」
 *   才送 PUT/POST（server 端也會 422，雙重保護）。
 */
import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebMemoryEntry,
  type MemoryAutoType,
} from '../../../api/client'
import { Modal } from '../../common/Modal'
import { containsSecret } from '../../../utils/secretScan'

const MEMORY_TYPES: MemoryAutoType[] = [
  'user',
  'feedback',
  'project',
  'reference',
]

export interface MemoryEditWizardProps {
  projectId: string
  /** 'edit' 模式必傳 entry；'create' 模式不傳 */
  entry: WebMemoryEntry | null
  /** create 模式預選 kind */
  createKind?: 'auto-memory' | 'local-config'
  /** body 預載（edit 模式 caller 先呼 api.memory.body 抓回來） */
  initialBody?: string
  open: boolean
  onClose: () => void
  /** 存檔成功後 caller 通常 close + refresh（broadcast 也會推 refresh） */
  onSaved?: () => void
}

export function MemoryEditWizard({
  projectId,
  entry,
  createKind,
  initialBody,
  open,
  onClose,
  onSaved,
}: MemoryEditWizardProps) {
  const isCreate = entry === null
  const kind = entry?.kind ?? createKind ?? 'auto-memory'
  const isAuto = kind === 'auto-memory'

  const [filename, setFilename] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<MemoryAutoType>('user')
  const [body, setBody] = useState('')
  const [override, setOverride] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // reset when modal opens
  useEffect(() => {
    if (!open) return
    setError(null)
    setOverride(false)
    setBusy(false)
    if (isCreate) {
      setFilename('')
      setName('')
      setDescription('')
      setType('user')
      setBody('')
    } else if (entry) {
      setFilename(entry.filename ?? '')
      setName(entry.displayName ?? '')
      setDescription(entry.description ?? '')
      setType('user')
      setBody(initialBody ?? '')
    }
  }, [open, entry, isCreate, initialBody])

  const secretHit = containsSecret(body)

  async function save() {
    setError(null)
    if (!body.trim()) {
      setError('body 不可為空')
      return
    }
    if (isCreate && !filename.trim()) {
      setError('filename 必填')
      return
    }
    if (isAuto && (!name.trim() || !description.trim())) {
      setError('auto-memory 需填 name + description')
      return
    }
    if (secretHit && !override) {
      setError('偵測到可能的 secret — 請勾「我已確認可寫入」再存檔')
      return
    }
    setBusy(true)
    try {
      if (isCreate) {
        if (kind === 'auto-memory') {
          await api.memory.create(projectId, {
            kind: 'auto-memory',
            filename,
            body,
            frontmatter: { name, description, type },
            override: secretHit ? true : undefined,
          })
        } else {
          await api.memory.create(projectId, {
            kind: 'local-config',
            filename,
            body,
            override: secretHit ? true : undefined,
          })
        }
      } else if (entry) {
        if (entry.kind === 'auto-memory') {
          await api.memory.update(projectId, {
            kind: 'auto-memory',
            filename: entry.filename ?? '',
            body,
            frontmatter: { name, description, type },
            override: secretHit ? true : undefined,
          })
        } else if (
          entry.kind === 'user-profile' ||
          entry.kind === 'project-memory' ||
          entry.kind === 'local-config'
        ) {
          await api.memory.update(projectId, {
            kind: entry.kind,
            absolutePath: entry.absolutePath,
            body,
            override: secretHit ? true : undefined,
          })
        } else {
          throw new Error(`kind=${entry.kind} 不可編輯`)
        }
      }
      onSaved?.()
      onClose()
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isCreate ? `New ${kind}` : `Edit ${entry?.displayName ?? ''}`}
    >
      <div className="flex flex-col gap-3 text-sm min-w-[480px]">
        {isCreate && (
          <Field label="filename">
            <input
              type="text"
              value={filename}
              onChange={e => setFilename(e.target.value)}
              placeholder={
                kind === 'auto-memory'
                  ? 'feedback_my_rule.md'
                  : 'CLAUDE.local.md'
              }
              className="w-full bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none font-mono text-xs"
            />
          </Field>
        )}
        {isAuto && (
          <>
            <Field label="name">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs"
              />
            </Field>
            <Field label="description">
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs"
              />
            </Field>
            <Field label="type">
              <select
                value={type}
                onChange={e => setType(e.target.value as MemoryAutoType)}
                className="bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none text-xs"
              >
                {MEMORY_TYPES.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="body">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={14}
            className="w-full bg-bg-floating px-2 py-1 rounded border border-divider focus:border-brand outline-none font-mono text-xs"
          />
        </Field>
        {secretHit && (
          <div className="flex flex-col gap-1 p-2 bg-status-dnd/20 border border-status-dnd/50 rounded text-xs">
            <span className="text-status-dnd font-semibold">
              ⚠ 偵測到可能的 secret 樣式（API key / token / 連線字串等）
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={override}
                onChange={e => setOverride(e.target.checked)}
                className="accent-brand"
              />
              <span>我已確認可寫入</span>
            </label>
          </div>
        )}
        {error && <div className="text-status-dnd text-xs">⚠ {error}</div>}
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 rounded bg-bg-accent hover:bg-bg-floating text-text-secondary text-xs disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 rounded bg-brand hover:bg-brand-hover text-white text-xs disabled:opacity-50"
          >
            {busy ? '存檔中…' : '存檔'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-text-muted text-[10px] uppercase tracking-wide">
        {label}
      </label>
      {children}
    </div>
  )
}
