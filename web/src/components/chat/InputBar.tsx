import { useEffect, useRef, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const CORE_SLASH_COMMANDS = [
  { name: 'clear', desc: '清空當前 session 的 chat 顯示（不刪 daemon 歷史）' },
  { name: 'interrupt', desc: '中斷當前 turn（送 input.interrupt）' },
  { name: 'allow', desc: '同意目前等待的 permission' },
  { name: 'deny', desc: '拒絕目前等待的 permission' },
  { name: 'mode', desc: '設定 permission mode（default / acceptEdits / bypassPermissions / plan）' },
]

export interface InputBarProps {
  onSubmit: (text: string) => void
  onInterrupt?: () => void
  onPermissionResponse?: (decision: 'allow' | 'deny') => void
  onSetMode?: (mode: string) => void
  onClear?: () => void
  hint?: string
  disabled?: boolean
}

export function InputBar({
  onSubmit,
  onInterrupt,
  onPermissionResponse,
  onSetMode,
  onClear,
  hint,
  disabled,
}: InputBarProps) {
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const showAc = text.startsWith('/') && !text.includes('\n')
  const acFiltered = showAc
    ? CORE_SLASH_COMMANDS.filter(c => c.name.startsWith(text.slice(1).split(/\s/)[0] ?? ''))
    : []

  useEffect(() => { setAcIndex(0) }, [text])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
  }, [text])

  function handleSubmit(): void {
    const v = text.trim()
    if (!v) return
    if (v.startsWith('/')) {
      const parts = v.slice(1).split(/\s+/)
      const cmd = parts[0]?.toLowerCase()
      const rest = parts.slice(1).join(' ')
      if (cmd === 'clear') onClear?.()
      else if (cmd === 'interrupt') onInterrupt?.()
      else if (cmd === 'allow') onPermissionResponse?.('allow')
      else if (cmd === 'deny') onPermissionResponse?.('deny')
      else if (cmd === 'mode') { if (rest) onSetMode?.(rest) }
      else onSubmit(v)
    } else {
      onSubmit(v)
    }
    setText('')
  }

  function applyAutocomplete(): void {
    const c = acFiltered[acIndex]
    if (!c) return
    setText('/' + c.name + ' ')
    requestAnimationFrame(() => taRef.current?.focus())
  }

  return (
    <div className="border-t px-4 py-3 bg-background relative">
      {showAc && acFiltered.length > 0 && (
        <div className="absolute left-4 right-4 bottom-full mb-2 bg-popover text-popover-foreground border rounded-md shadow-md max-h-60 overflow-y-auto z-10">
          {acFiltered.map((c, i) => (
            <div
              key={c.name}
              onMouseEnter={() => setAcIndex(i)}
              onClick={() => { setAcIndex(i); applyAutocomplete() }}
              className={cn(
                'px-3 py-2 cursor-pointer flex items-baseline gap-2',
                i === acIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              <span className="text-primary font-mono text-sm">/{c.name}</span>
              <span className="text-muted-foreground text-xs">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      <Textarea
        ref={taRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={e => {
          if (composing) return
          if (showAc && acFiltered.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex(i => Math.min(acFiltered.length - 1, i + 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex(i => Math.max(0, i - 1)); return }
            if (e.key === 'Tab') { e.preventDefault(); applyAutocomplete(); return }
            if (e.key === 'Escape') { e.preventDefault(); setText(''); return }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
          }
        }}
        disabled={disabled}
        placeholder={disabled ? '連線中斷' : '送訊息（Enter 送出 · Shift+Enter 換行 · / 看 slash 指令）'}
        rows={1}
        className="resize-none text-sm"
      />
      <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
        <span>{hint ?? ''}</span>
        <span className="font-mono">⏎ 送 · ⇧⏎ 換行 · / slash</span>
      </div>
    </div>
  )
}
