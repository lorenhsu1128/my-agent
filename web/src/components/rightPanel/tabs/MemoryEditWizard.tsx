import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type WebMemoryEntry,
  type MemoryAutoType,
} from '../../../api/client'
import { containsSecret } from '../../../utils/secretScan'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const MEMORY_TYPES: MemoryAutoType[] = ['user', 'feedback', 'project', 'reference']

export interface MemoryEditWizardProps {
  projectId: string
  entry: WebMemoryEntry | null
  createKind?: 'auto-memory' | 'local-config'
  initialBody?: string
  open: boolean
  onClose: () => void
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

  useEffect(() => {
    if (!open) return
    setError(null); setOverride(false); setBusy(false)
    if (isCreate) {
      setFilename(''); setName(''); setDescription(''); setType('user'); setBody('')
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
    if (!body.trim()) { setError('body 不可為空'); return }
    if (isCreate && !filename.trim()) { setError('filename 必填'); return }
    if (isAuto && (!name.trim() || !description.trim())) {
      setError('auto-memory 需填 name + description'); return
    }
    if (secretHit && !override) {
      setError('偵測到可能的 secret — 請勾「我已確認可寫入」再存檔'); return
    }
    setBusy(true)
    try {
      if (isCreate) {
        if (kind === 'auto-memory') {
          await api.memory.create(projectId, {
            kind: 'auto-memory', filename, body,
            frontmatter: { name, description, type },
            override: secretHit ? true : undefined,
          })
        } else {
          await api.memory.create(projectId, {
            kind: 'local-config', filename, body,
            override: secretHit ? true : undefined,
          })
        }
      } else if (entry) {
        if (entry.kind === 'auto-memory') {
          await api.memory.update(projectId, {
            kind: 'auto-memory', filename: entry.filename ?? '', body,
            frontmatter: { name, description, type },
            override: secretHit ? true : undefined,
          })
        } else if (entry.kind === 'user-profile' || entry.kind === 'project-memory' || entry.kind === 'local-config') {
          await api.memory.update(projectId, {
            kind: entry.kind, absolutePath: entry.absolutePath, body,
            override: secretHit ? true : undefined,
          })
        } else {
          throw new Error(`kind=${entry.kind} 不可編輯`)
        }
      }
      onSaved?.(); onClose()
    } catch (e) {
      setError(
        e instanceof ApiError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e),
      )
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? `New ${kind}` : `Edit ${entry?.displayName ?? ''}`}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {isCreate && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mem-filename">filename</Label>
              <Input
                id="mem-filename"
                value={filename}
                onChange={e => setFilename(e.target.value)}
                placeholder={kind === 'auto-memory' ? 'feedback_my_rule.md' : 'CLAUDE.local.md'}
                className="font-mono text-xs"
              />
            </div>
          )}
          {isAuto && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mem-name">name</Label>
                <Input id="mem-name" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mem-desc">description</Label>
                <Input id="mem-desc" value={description} onChange={e => setDescription(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>type</Label>
                <Select value={type} onValueChange={v => setType(v as MemoryAutoType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MEMORY_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mem-body">body</Label>
            <Textarea
              id="mem-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={14}
              className="font-mono text-xs"
            />
          </div>
          {secretHit && (
            <div className="flex flex-col gap-1 p-2 bg-destructive/15 border border-destructive/40 rounded text-xs">
              <span className="text-destructive font-semibold">⚠ 偵測到可能的 secret 樣式（API key / token / 連線字串等）</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={e => setOverride(e.target.checked)}
                  className="accent-primary"
                />
                <span>我已確認可寫入</span>
              </label>
            </div>
          )}
          {error && <div className="text-destructive text-xs">⚠ {error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? '存檔中…' : '存檔'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
