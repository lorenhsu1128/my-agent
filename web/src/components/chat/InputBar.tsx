/**
 * M-WEB-12：訊息輸入框 + 5 個核心 slash autocomplete。
 *
 * 行為：
 *   - Enter 送出（IME 中按 Enter 不送）；Shift+Enter 換行
 *   - 開頭 `/` 觸發 autocomplete dropdown，TAB / Enter 補全
 *   - 5 個核心 slash：/clear /interrupt /allow /deny /mode
 *   - turn 進行中也可送（搶占 = interactive intent；daemon InputQueue 處理中斷）
 */
import { useEffect, useRef, useState } from 'react'

const CORE_SLASH_COMMANDS = [
  { name: 'clear', desc: '清空當前 session 的 chat 顯示（不刪 daemon 歷史）' },
  { name: 'interrupt', desc: '中斷當前 turn（送 input.interrupt）' },
  { name: 'allow', desc: '同意目前等待的 permission' },
  { name: 'deny', desc: '拒絕目前等待的 permission' },
  { name: 'mode', desc: '設定 permission mode（default / acceptEdits / bypassPermissions / plan）' },
]

export interface InputBarProps {
  /** 送出純文字訊息（已剝去開頭 `/` 由 caller 自行判斷 slash）。 */
  onSubmit: (text: string) => void
  /** 中斷當前 turn 的 callback（slash `/interrupt` 觸發）。 */
  onInterrupt?: () => void
  /** Permission allow/deny 的 callback；caller 可 ignore（如目前無 pending）。 */
  onPermissionResponse?: (decision: 'allow' | 'deny') => void
  /** 切 mode 的 callback。 */
  onSetMode?: (mode: string) => void
  /** Clear chat 的 callback。 */
  onClear?: () => void
  /** 顯示給使用者的 footer hint（例「session foo · turn running」）。 */
  hint?: string
  /** 禁用（連線中斷時）。 */
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

  // Autocomplete：text 開頭 / 且不含 newline 才顯示
  const showAc =
    text.startsWith('/') && !text.includes('\n')
  const acFiltered = showAc
    ? CORE_SLASH_COMMANDS.filter(c =>
        c.name.startsWith(text.slice(1).split(/\s/)[0] ?? ''),
      )
    : []

  useEffect(() => {
    setAcIndex(0)
  }, [text])

  // textarea auto-resize
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
      if (cmd === 'clear') {
        onClear?.()
      } else if (cmd === 'interrupt') {
        onInterrupt?.()
      } else if (cmd === 'allow') {
        onPermissionResponse?.('allow')
      } else if (cmd === 'deny') {
        onPermissionResponse?.('deny')
      } else if (cmd === 'mode') {
        if (rest) onSetMode?.(rest)
      } else {
        // 未支援的 slash → 一般文字送出（讓 daemon LLM 看到「/foo」原文）
        onSubmit(v)
      }
    } else {
      onSubmit(v)
    }
    setText('')
  }

  function applyAutocomplete(): void {
    const c = acFiltered[acIndex]
    if (!c) return
    setText('/' + c.name + ' ')
    requestAnimationFrame(() => {
      taRef.current?.focus()
    })
  }

  return (
    <div className="border-t border-divider px-4 py-3 bg-bg-primary relative">
      {showAc && acFiltered.length > 0 && (
        <div className="absolute left-4 right-4 bottom-full mb-2 bg-bg-floating border border-divider rounded shadow-lg max-h-60 overflow-y-auto z-10">
          {acFiltered.map((c, i) => (
            <div
              key={c.name}
              onMouseEnter={() => setAcIndex(i)}
              onClick={() => {
                setAcIndex(i)
                applyAutocomplete()
              }}
              className={[
                'px-3 py-2 cursor-pointer flex items-baseline gap-2',
                i === acIndex ? 'bg-bg-accent' : 'hover:bg-bg-accent/60',
              ].join(' ')}
            >
              <span className="text-brand font-mono text-sm">/{c.name}</span>
              <span className="text-text-muted text-xs">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={e => {
          if (composing) return
          if (showAc && acFiltered.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setAcIndex(i => Math.min(acFiltered.length - 1, i + 1))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setAcIndex(i => Math.max(0, i - 1))
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              applyAutocomplete()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setText('')
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
          }
        }}
        disabled={disabled}
        placeholder={
          disabled
            ? '連線中斷'
            : '送訊息（Enter 送出 · Shift+Enter 換行 · / 看 slash 指令）'
        }
        rows={1}
        className="w-full resize-none bg-bg-tertiary text-text-primary px-3 py-2 rounded border border-divider focus:border-brand outline-none text-sm font-sans"
      />
      <div className="flex items-center justify-between mt-1 text-xs text-text-muted">
        <span>{hint ?? ''}</span>
        <span className="font-mono">⏎ 送 · ⇧⏎ 換行 · / slash</span>
      </div>
    </div>
  )
}
