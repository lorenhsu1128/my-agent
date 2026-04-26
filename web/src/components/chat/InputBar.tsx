import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  filterCommandsForAutocomplete,
  useSlashCommandStore,
} from '@/store/slashCommandStore'
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
}: InputBarProps) {
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const { commands, ensureLoaded } = useSlashCommandStore()

  // 第一次顯示 dropdown 時拉 metadata（5min cache 內 noop）
  const showAc = text.startsWith('/') && !text.includes('\n')
  useEffect(() => {
    if (showAc) void ensureLoaded(projectId)
  }, [showAc, projectId, ensureLoaded])

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
      if (meta.webKind === 'runnable' && meta.type === 'prompt') {
        toast.info(`/${cmd} (prompt) 尚未接通`, {
          description: 'M-WEB-SLASH-B1 將在 web 端執行 prompt 注入',
        })
      } else if (meta.webKind === 'runnable' && meta.type === 'local') {
        toast.info(`/${cmd} (local) 尚未接通`, {
          description: 'M-WEB-SLASH-B2 將在 web 端執行 local 命令',
        })
      } else if (meta.webKind === 'web-redirect') {
        toast.info(`/${cmd} → ${meta.handoffKey} tab`, {
          description: 'M-WEB-SLASH-C1 將自動跳到對應 tab',
        })
      } else if (meta.webKind === 'jsx-handoff') {
        toast.info(`/${cmd} (互動 UI)`, {
          description: 'M-WEB-SLASH-D 將提供對應的 React 互動元件',
        })
      }
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
