import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  filterCommandsForAutocomplete,
  useSlashCommandStore,
} from '@/store/slashCommandStore'
import { api } from '@/api/client'
import type {
  WebSlashCommandKind,
  WebSlashCommandMetadata,
} from '@/api/client'

/**
 * 5 個本地直接動作的 slash command — 不走 daemon，由 InputBar 直接呼 callback。
 * 其他 87 個命令走 store + WS RPC（B1/B2/C1/D 階段陸續接通）。
 */
const LOCAL_ACTION_COMMANDS = new Set([
  'clear',
  'interrupt',
  'allow',
  'deny',
  'mode',
])

function badgeForKind(
  kind: WebSlashCommandKind,
): { label: string; variant: 'default' | 'secondary' | 'outline' } {
  if (kind === 'runnable') return { label: 'runnable', variant: 'default' }
  if (kind === 'web-redirect') return { label: 'web tab', variant: 'secondary' }
  return { label: 'jsx', variant: 'outline' }
}

export interface InputBarProps {
  onSubmit: (text: string) => void
  onInterrupt?: () => void
  onPermissionResponse?: (decision: 'allow' | 'deny') => void
  onSetMode?: (mode: string) => void
  onClear?: () => void
  hint?: string
  disabled?: boolean
  /** 當前 project — 給 store ensureLoaded 用，可選 */
  projectId?: string
  /**
   * M-WEB-SLASH-B1/B2：對非 LOCAL_ACTION_COMMANDS 的 runnable command 走 WS
   * slashCommand.execute；ChatView 監聽 result event 顯示 toast。
   * 回 true 表示已 dispatch。
   */
  onSlashExecute?: (name: string, args: string) => boolean
}

export function InputBar({
  onSubmit,
  onInterrupt,
  onPermissionResponse,
  onSetMode,
  onClear,
  hint,
  disabled,
  projectId,
  onSlashExecute,
}: InputBarProps) {
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const { commands, ensureLoaded } = useSlashCommandStore()
  // M-WEB-PARITY-4：@file typeahead 狀態
  const [fileMatches, setFileMatches] = useState<
    { path: string; type: 'file' | 'dir' }[]
  >([])
  const [fileAcIndex, setFileAcIndex] = useState(0)
  const fileQueryRef = useRef<string>('')

  // 第一次顯示 dropdown 時拉 metadata（5min cache 內 noop）
  const showAc = text.startsWith('/') && !text.includes('\n')
  useEffect(() => {
    if (showAc) void ensureLoaded(projectId)
  }, [showAc, projectId, ensureLoaded])

  // M-WEB-PARITY-4：偵測游標前最後一個 @<token>。游標位置由 textarea 的
  // selectionEnd 取得；token 從 @ 後到下一個空白為止。
  function getAtToken(): { token: string; start: number; end: number } | null {
    const ta = taRef.current
    if (!ta) return null
    const pos = ta.selectionEnd ?? text.length
    const before = text.slice(0, pos)
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (!m) return null
    const tokenStart = pos - m[1]!.length
    return { token: m[1]!, start: tokenStart - 1, end: pos }
  }

  const atToken = getAtToken()
  const showFileAc = atToken !== null && !showAc

  useEffect(() => {
    if (!showFileAc || !projectId || !atToken) {
      setFileMatches([])
      return
    }
    // 200ms debounce 防 keystroke 高頻打 API
    fileQueryRef.current = atToken.token
    const handle = setTimeout(() => {
      if (fileQueryRef.current !== atToken.token) return
      api
        .searchFiles(projectId, atToken.token, 30)
        .then(r => {
          if (fileQueryRef.current !== atToken.token) return // 已輸入新值
          setFileMatches(r.files)
          setFileAcIndex(0)
        })
        .catch(() => setFileMatches([]))
    }, 200)
    return () => clearTimeout(handle)
  }, [showFileAc, projectId, atToken?.token])

  function applyFileAutocomplete(): void {
    const f = fileMatches[fileAcIndex]
    if (!f || !atToken) return
    const before = text.slice(0, atToken.start)
    const after = text.slice(atToken.end)
    const insert = '@' + f.path + (f.type === 'dir' ? '/' : ' ')
    setText(before + insert + after)
    setFileMatches([])
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      const newPos = before.length + insert.length
      ta.focus()
      ta.setSelectionRange(newPos, newPos)
    })
  }

  const acFiltered = useMemo<WebSlashCommandMetadata[]>(() => {
    if (!showAc) return []
    const query = text.slice(1).split(/\s/)[0] ?? ''
    return filterCommandsForAutocomplete(commands, query).slice(0, 30)
  }, [showAc, text, commands])

  useEffect(() => {
    setAcIndex(0)
  }, [text])

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
      const cmd = parts[0]?.toLowerCase() ?? ''
      const rest = parts.slice(1).join(' ')

      if (LOCAL_ACTION_COMMANDS.has(cmd)) {
        if (cmd === 'clear') onClear?.()
        else if (cmd === 'interrupt') onInterrupt?.()
        else if (cmd === 'allow') onPermissionResponse?.('allow')
        else if (cmd === 'deny') onPermissionResponse?.('deny')
        else if (cmd === 'mode') {
          if (rest) onSetMode?.(rest)
        }
        setText('')
        return
      }

      // 查 store 看命令是否存在 + 給對應 hint。實際執行路徑會在
      // M-WEB-SLASH-B1（prompt）/ B2（local）/ C1（web-redirect）/
      // D1-D6（jsx-handoff）逐步接通。
      const meta = commands.find(
        c => c.userFacingName === cmd || c.aliases?.includes(cmd),
      )
      if (!meta) {
        toast.error(`未知 slash 命令：/${cmd}`, {
          description: '/help 列出所有可用命令',
        })
        return
      }
      // 所有非 LOCAL_ACTION 命令統一走 WS slashCommand.execute；result kind
      // 決定後續行為（runnable→toast、web-redirect→跳 tab、jsx-handoff→展開
      // React 元件）。處理在 ChatView.executeSlash 的 frame handler。
      if (onSlashExecute && onSlashExecute(meta.userFacingName, rest)) {
        setText('')
        return
      }
      toast.error(`/${cmd} 無法執行（WS 未連線）`)
      setText('')
      return
    }
    onSubmit(v)
    setText('')
  }

  function applyAutocomplete(): void {
    const c = acFiltered[acIndex]
    if (!c) return
    setText('/' + c.userFacingName + ' ')
    requestAnimationFrame(() => taRef.current?.focus())
  }

  return (
    <div className="border-t px-4 py-3 bg-background relative">
      {showAc && acFiltered.length > 0 && (
        <div className="absolute left-4 right-4 bottom-full mb-2 bg-popover text-popover-foreground border rounded-md shadow-md max-h-72 overflow-y-auto z-10">
          {acFiltered.map((c, i) => {
            const badge = badgeForKind(c.webKind)
            return (
              <div
                key={c.name}
                onMouseEnter={() => setAcIndex(i)}
                onClick={() => {
                  setAcIndex(i)
                  applyAutocomplete()
                }}
                className={cn(
                  'px-3 py-2 cursor-pointer flex items-center gap-2',
                  i === acIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60',
                )}
              >
                <span className="text-primary font-mono text-sm flex-shrink-0">
                  /{c.userFacingName}
                </span>
                <Badge
                  variant={badge.variant}
                  className="text-[10px] py-0 px-1.5 h-4 flex-shrink-0"
                >
                  {badge.label}
                </Badge>
                <span className="text-muted-foreground text-xs truncate">
                  {c.description}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {showAc && acFiltered.length === 0 && commands.length > 0 && (
        <div className="absolute left-4 right-4 bottom-full mb-2 bg-popover text-popover-foreground border rounded-md shadow-md px-3 py-2 z-10 text-xs text-muted-foreground">
          沒有符合的命令
        </div>
      )}
      {showFileAc && fileMatches.length > 0 && (
        <div className="absolute left-4 right-4 bottom-full mb-2 bg-popover text-popover-foreground border rounded-md shadow-md max-h-72 overflow-y-auto z-10">
          {fileMatches.map((f, i) => (
            <div
              key={f.path}
              onMouseEnter={() => setFileAcIndex(i)}
              onClick={() => {
                setFileAcIndex(i)
                applyFileAutocomplete()
              }}
              className={cn(
                'px-3 py-1.5 cursor-pointer flex items-center gap-2 text-xs font-mono',
                i === fileAcIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/60',
              )}
            >
              <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 flex-shrink-0">
                {f.type === 'dir' ? 'dir' : 'file'}
              </Badge>
              <span className="truncate">{f.path}</span>
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
          if (showFileAc && fileMatches.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setFileAcIndex(i => Math.min(fileMatches.length - 1, i + 1))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setFileAcIndex(i => Math.max(0, i - 1))
              return
            }
            if (e.key === 'Tab' || e.key === 'Enter') {
              e.preventDefault()
              applyFileAutocomplete()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setFileMatches([])
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
        className="resize-none text-sm"
      />
      <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
        <span>{hint ?? ''}</span>
        <span className="font-mono">⏎ 送 · ⇧⏎ 換行 · / slash</span>
      </div>
    </div>
  )
}
